import { Client as SSHClient } from 'ssh2';
import { Pool } from 'pg';
import * as net from 'net';
import { config } from '../config/index.js';

const SCHEMA = 'v3knowledge';
const EMBEDDING_DIMS = 768; // nomic-embed-text produces 768-dim vectors

export interface Document {
  id: number;
  source_type: string;
  source_path: string;
  title: string | null;
  metadata?: Record<string, any>;
  ingested_at: Date;
}

interface Chunk {
  id: number;
  doc_id: number;
  chunk_text: string;
  chunk_index: number;
  metadata: Record<string, any>;
}

export interface SearchResult {
  chunk_text: string;
  similarity: number;
  source_type: string;
  source_path: string;
  title: string | null;
  metadata: Record<string, any>;
}

export interface KnowledgeFilters {
  role?: string;
  category?: string;
  subCategory?: string;
  company?: string;
  project?: string;
  commodity?: string;
  tags?: string[];
}

export interface KnowledgeIntakeRecord {
  id: number;
  source_type: 'file' | 'url' | 'text';
  source_path: string;
  source_url: string | null;
  title: string;
  status: 'review_required' | 'ready_to_ingest' | 'ingested' | 'error';
  role: string | null;
  category: string | null;
  sub_category: string | null;
  company: string | null;
  project: string | null;
  commodity: string | null;
  tags: string[];
  suggested_role: string | null;
  suggested_category: string | null;
  suggested_sub_category: string | null;
  suggested_company: string | null;
  suggested_project: string | null;
  suggested_commodity: string | null;
  suggested_tags: string[];
  classification_confidence: number;
  classification_reasoning: string | null;
  content_hash: string | null;
  content_preview: string;
  source_metadata: Record<string, any>;
  ingestion_result: Record<string, any>;
  read_only: boolean;
  created_at: Date;
  updated_at: Date;
  ingested_at: Date | null;
}

export class VectorService {
  private sshClient: SSHClient | null = null;
  private tunnelServer: net.Server | null = null;
  private pool: Pool | null = null;
  private connected = false;
  private localPort: number;

  constructor() {
    this.localPort = config.pg.port;
  }

  /**
   * Establish SSH tunnel and PostgreSQL connection.
   * Called once at server startup.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    try {
      // Step 1: SSH tunnel (if SSH host is configured AND PG_HOST is localhost)
      // Check if port is already in use (manual tunnel running)
      const portInUse = await this.isPortInUse(this.localPort);
      if (portInUse) {
        console.log(`[VectorService] Port ${this.localPort} already in use — assuming manual SSH tunnel is running`);
      } else if (config.ssh.host && config.pg.host === '127.0.0.1') {
        console.log(`[VectorService] SSH config: host=${config.ssh.host}, port=${config.ssh.port}, user=${config.ssh.username}, password=${config.ssh.password ? '***' : 'EMPTY'}`);
        console.log(`[VectorService] Establishing SSH tunnel to ${config.ssh.host}:${config.ssh.port} as ${config.ssh.username}`);
        try {
          await this.createSSHTunnel();
          console.log(`[VectorService] SSH tunnel active on 127.0.0.1:${this.localPort}`);
        } catch (e: any) {
          console.warn(`[VectorService] SSH tunnel failed: ${e.message}`);
          console.warn(`[VectorService] To enable knowledge features, run: node test-ssh.cjs (keeps tunnel open)`);
          throw e;
        }
      } else if (config.pg.host !== '127.0.0.1') {
        console.log(`[VectorService] Connecting to remote PostgreSQL at ${config.pg.host}:${config.pg.port} (assumes tunnel is already set up)`);
      }

      // Step 2: PostgreSQL connection pool
      const pwdLen = config.pg.password?.length || 0;
      const pwdFirst = config.pg.password?.substring(0, 3) || 'N/A';
      const pwdLast = config.pg.password?.substring(pwdLen - 3) || 'N/A';
      console.log(`[VectorService] PG config: host=${config.pg.host}, port=${this.localPort}, database=${config.pg.database}, user=${config.pg.user}`);
      console.log(`[VectorService] PG password: length=${pwdLen}, first3=${pwdFirst}, last3=${pwdLast}`);
      this.pool = new Pool({
        host: config.pg.host,
        port: this.localPort,
        database: config.pg.database,
        user: config.pg.user,
        password: config.pg.password,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(`[VectorService] PostgreSQL connected to ${config.pg.database}`);

      // Step 3: Initialize schema
      await this.initSchema();
      this.connected = true;
      return true;
    } catch (error: any) {
      console.warn(`[VectorService] Connection failed: ${error.message}`);
      console.warn(`[VectorService] Knowledge features will be unavailable until DB is reachable.`);
      return false;
    }
  }

  /**
   * Check if a port is already in use.
   */
  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true)); // Port in use
      server.once('listening', () => {
        server.close();
        resolve(false); // Port available
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Create SSH tunnel using ssh2 library.
   * Forwards local port to remote PostgreSQL via SSH.
   */
  private createSSHTunnel(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sshClient = new SSHClient();

      this.sshClient.on('ready', () => {
        // Create local TCP server that forwards through SSH
        this.tunnelServer = net.createServer((socket) => {
          this.sshClient!.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            '127.0.0.1',
            5432,
            (err, stream) => {
              if (err) {
                socket.end();
                return;
              }
              socket.pipe(stream).pipe(socket);
              socket.on('close', () => stream.end());
              stream.on('close', () => socket.end());
              stream.on('error', () => socket.destroy());
              socket.on('error', () => stream.end());
            }
          );
        });

        this.tunnelServer!.listen(this.localPort, '127.0.0.1', () => {
          resolve();
        });

        this.tunnelServer!.on('error', (err) => reject(err));
      });

      this.sshClient.on('error', (err) => reject(err));

      this.sshClient.connect({
        host: config.ssh.host,
        port: config.ssh.port,
        username: config.ssh.username,
        password: config.ssh.password,
        readyTimeout: 15000,
      });
    });
  }

  /**
   * Initialize the v3knowledge schema with documents and chunks tables.
   */
  private async initSchema(): Promise<void> {
    const client = await this.pool!.connect();

    try {
      // Ensure pgvector extension exists
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      // Create schema
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

      // Documents table — tracks source files/URLs
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.documents (
          id SERIAL PRIMARY KEY,
          source_type TEXT NOT NULL CHECK (source_type IN ('file', 'url', 'text')),
          source_path TEXT NOT NULL,
          title TEXT,
          file_hash TEXT,
          metadata JSONB DEFAULT '{}',
          intake_record_id INT,
          ingested_at TIMESTAMPTZ DEFAULT now()
        )
      `);

      // Chunks table — stores text chunks with embeddings
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.chunks (
          id SERIAL PRIMARY KEY,
          doc_id INT NOT NULL REFERENCES ${SCHEMA}.documents(id) ON DELETE CASCADE,
          chunk_text TEXT NOT NULL,
          chunk_index INT NOT NULL,
          embedding vector(${EMBEDDING_DIMS}),
          metadata JSONB DEFAULT '{}'
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.knowledge_intake_records (
          id SERIAL PRIMARY KEY,
          source_type TEXT NOT NULL CHECK (source_type IN ('file', 'url', 'text')),
          source_path TEXT NOT NULL,
          source_url TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'review_required',
          role TEXT,
          category TEXT,
          sub_category TEXT,
          company TEXT,
          project TEXT,
          commodity TEXT,
          tags JSONB DEFAULT '[]',
          suggested_role TEXT,
          suggested_category TEXT,
          suggested_sub_category TEXT,
          suggested_company TEXT,
          suggested_project TEXT,
          suggested_commodity TEXT,
          suggested_tags JSONB DEFAULT '[]',
          classification_confidence REAL DEFAULT 0,
          classification_reasoning TEXT,
          content_hash TEXT,
          content_preview TEXT DEFAULT '',
          source_metadata JSONB DEFAULT '{}',
          ingestion_result JSONB DEFAULT '{}',
          read_only BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now(),
          ingested_at TIMESTAMPTZ
        )
      `);

      await client.query(`
        ALTER TABLE ${SCHEMA}.documents
        ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.documents
        ADD COLUMN IF NOT EXISTS intake_record_id INT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS sub_category TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS company TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS project TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS commodity TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS suggested_sub_category TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS suggested_company TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS suggested_project TEXT
      `);
      await client.query(`
        ALTER TABLE ${SCHEMA}.knowledge_intake_records
        ADD COLUMN IF NOT EXISTS suggested_commodity TEXT
      `);

      // Index for fast similarity search (IVFFlat — good for moderate dataset sizes)
      // Only create if not exists (can't CREATE IF NOT EXISTS for indexes)
      const indexCheck = await client.query(`
        SELECT 1 FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND indexname = 'chunks_embedding_idx'
      `);
      if (indexCheck.rows.length === 0) {
        await client.query(`
          CREATE INDEX chunks_embedding_idx ON ${SCHEMA}.chunks
          USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
        `);
      }

      // Index for fast doc lookups
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON ${SCHEMA}.chunks (doc_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_role_idx ON ${SCHEMA}.chunks ((metadata->>'role'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_category_idx ON ${SCHEMA}.chunks ((metadata->>'category'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_sub_category_idx ON ${SCHEMA}.chunks ((metadata->>'sub_category'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_company_idx ON ${SCHEMA}.chunks ((metadata->>'company'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_project_idx ON ${SCHEMA}.chunks ((metadata->>'project'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_commodity_idx ON ${SCHEMA}.chunks ((metadata->>'commodity'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS intake_records_status_idx ON ${SCHEMA}.knowledge_intake_records (status)
      `);

      // Unique constraint on source_path to avoid duplicate ingestion
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS documents_source_path_idx ON ${SCHEMA}.documents (source_path)
      `);

      console.log(`[VectorService] Schema '${SCHEMA}' initialized (pgvector ${EMBEDDING_DIMS}d)`);
    } finally {
      client.release();
    }
  }

  /**
   * Generate embedding for a text using Ollama.
   */
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${config.ollama.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.embeddingModel,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Add a document and its chunks to the vector store.
   * If document already exists (by source_path), it's replaced.
   */
  async addDocument(
    sourceType: 'file' | 'url' | 'text',
    sourcePath: string,
    title: string | null,
    chunks: string[],
    fileHash?: string,
    metadata: Record<string, any> = {},
    intakeRecordId?: number
  ): Promise<number> {
    const client = await this.pool!.connect();

    try {
      // Upsert document (delete old + re-insert if exists)
      await client.query(
        `DELETE FROM ${SCHEMA}.documents WHERE source_path = $1`,
        [sourcePath]
      );

      const docResult = await client.query(
        `INSERT INTO ${SCHEMA}.documents (source_type, source_path, title, file_hash, metadata, intake_record_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
        [sourceType, sourcePath, title, fileHash || null, JSON.stringify(metadata || {}), intakeRecordId || null]
      );
      const docId = docResult.rows[0].id;

      // Embed and insert chunks in batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await Promise.all(batch.map(c => this.embed(c)));

        for (let j = 0; j < batch.length; j++) {
          const chunkIndex = i + j;
          const embedding = embeddings[j];
          const embeddingStr = `[${embedding.join(',')}]`;

          await client.query(
            `INSERT INTO ${SCHEMA}.chunks (doc_id, chunk_text, chunk_index, embedding, metadata)
             VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
            [docId, batch[j], chunkIndex, embeddingStr, JSON.stringify(metadata || {})]
          );
        }

        console.log(`[VectorService] Embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} chunks for "${sourcePath}"`);
      }

      console.log(`[VectorService] Ingested "${sourcePath}": ${chunks.length} chunks`);
      return docId;
    } finally {
      client.release();
    }
  }

  /**
   * Search for similar chunks using cosine similarity.
   */
  async search(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.3,
    filters: KnowledgeFilters = {}
  ): Promise<SearchResult[]> {
    if (!this.connected) return [];

    const queryEmbedding = await this.embed(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const client = await this.pool!.connect();

    try {
      const whereClauses = ['c.embedding IS NOT NULL'];
      const params: any[] = [embeddingStr];
      let nextParam = 2;

      if (filters.role) {
        whereClauses.push(`LOWER(c.metadata->>'role') = LOWER($${nextParam})`);
        params.push(filters.role);
        nextParam++;
      }
      if (filters.category) {
        whereClauses.push(`LOWER(c.metadata->>'category') = LOWER($${nextParam})`);
        params.push(filters.category);
        nextParam++;
      }
      if (filters.subCategory) {
        whereClauses.push(`LOWER(c.metadata->>'sub_category') = LOWER($${nextParam})`);
        params.push(filters.subCategory);
        nextParam++;
      }
      if (filters.company) {
        whereClauses.push(`LOWER(c.metadata->>'company') = LOWER($${nextParam})`);
        params.push(filters.company);
        nextParam++;
      }
      if (filters.project) {
        whereClauses.push(`LOWER(c.metadata->>'project') = LOWER($${nextParam})`);
        params.push(filters.project);
        nextParam++;
      }
      if (filters.commodity) {
        whereClauses.push(`LOWER(c.metadata->>'commodity') = LOWER($${nextParam})`);
        params.push(filters.commodity);
        nextParam++;
      }
      if (filters.tags && filters.tags.length > 0) {
        whereClauses.push(`c.metadata->'tags' ?| $${nextParam}`);
        params.push(filters.tags);
        nextParam++;
      }
      params.push(limit);

      const result = await client.query(
        `SELECT
          c.chunk_text,
          1 - (c.embedding <=> $1::vector) AS similarity,
          d.source_type,
          d.source_path,
          d.title,
          c.metadata
        FROM ${SCHEMA}.chunks c
        JOIN ${SCHEMA}.documents d ON c.doc_id = d.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $${nextParam}`,
        params
      );

      return result.rows
        .map(r => ({
          chunk_text: r.chunk_text,
          similarity: parseFloat(r.similarity),
          source_type: r.source_type,
          source_path: r.source_path,
          title: r.title,
          metadata: r.metadata || {},
        }))
        .filter(r => r.similarity >= minSimilarity);
    } finally {
      client.release();
    }
  }

  /**
   * Get all documents in the knowledge base.
   */
  async listDocuments(): Promise<Document[]> {
    if (!this.connected) return [];

    const result = await this.pool!.query(
      `SELECT id, source_type, source_path, title, metadata, ingested_at
       FROM ${SCHEMA}.documents ORDER BY ingested_at DESC`
    );
    return result.rows;
  }

  async getKnowledgeTaxonomy(): Promise<{ roles: string[]; categories: string[]; subCategories: string[]; companies: string[]; projects: string[]; commodities: string[] }> {
    if (!this.connected) return { roles: [], categories: [], subCategories: [], companies: [], projects: [], commodities: [] };

    const [roles, categories, subCategories, companies, projects, commodities] = await Promise.all([
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'role') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'role', '') <> ''
        ORDER BY value
      `),
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'category') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'category', '') <> ''
        ORDER BY value
      `),
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'sub_category') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'sub_category', '') <> ''
        ORDER BY value
      `),
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'company') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'company', '') <> ''
        ORDER BY value
      `),
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'project') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'project', '') <> ''
        ORDER BY value
      `),
      this.pool!.query(`
        SELECT DISTINCT TRIM(metadata->>'commodity') AS value
        FROM ${SCHEMA}.chunks
        WHERE COALESCE(metadata->>'commodity', '') <> ''
        ORDER BY value
      `),
    ]);

    return {
      roles: roles.rows.map(row => row.value).filter(Boolean),
      categories: categories.rows.map(row => row.value).filter(Boolean),
      subCategories: subCategories.rows.map(row => row.value).filter(Boolean),
      companies: companies.rows.map(row => row.value).filter(Boolean),
      projects: projects.rows.map(row => row.value).filter(Boolean),
      commodities: commodities.rows.map(row => row.value).filter(Boolean),
    };
  }

  async createKnowledgeIntakeRecord(input: {
    sourceType: 'file' | 'url' | 'text';
    sourcePath: string;
    sourceUrl?: string | null;
    title: string;
    status: KnowledgeIntakeRecord['status'];
    role?: string | null;
    category?: string | null;
    subCategory?: string | null;
    company?: string | null;
    project?: string | null;
    commodity?: string | null;
    tags?: string[];
    suggestedRole?: string | null;
    suggestedCategory?: string | null;
    suggestedSubCategory?: string | null;
    suggestedCompany?: string | null;
    suggestedProject?: string | null;
    suggestedCommodity?: string | null;
    suggestedTags?: string[];
    classificationConfidence?: number;
    classificationReasoning?: string | null;
    contentHash?: string | null;
    contentPreview?: string;
    sourceMetadata?: Record<string, any>;
  }): Promise<KnowledgeIntakeRecord> {
    this.ensureConnected();
    const result = await this.pool!.query(
      `INSERT INTO ${SCHEMA}.knowledge_intake_records (
         source_type, source_path, source_url, title, status, role, category, sub_category, company, project, commodity, tags,
         suggested_role, suggested_category, suggested_sub_category, suggested_company, suggested_project, suggested_commodity, suggested_tags, classification_confidence,
         classification_reasoning, content_hash, content_preview, source_metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
         $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24::jsonb
       )
       RETURNING *`,
      [
        input.sourceType,
        input.sourcePath,
        input.sourceUrl || null,
        input.title,
        input.status,
        input.role || null,
        input.category || null,
        input.subCategory || null,
        input.company || null,
        input.project || null,
        input.commodity || null,
        JSON.stringify(input.tags || []),
        input.suggestedRole || null,
        input.suggestedCategory || null,
        input.suggestedSubCategory || null,
        input.suggestedCompany || null,
        input.suggestedProject || null,
        input.suggestedCommodity || null,
        JSON.stringify(input.suggestedTags || []),
        input.classificationConfidence || 0,
        input.classificationReasoning || null,
        input.contentHash || null,
        input.contentPreview || '',
        JSON.stringify(input.sourceMetadata || {}),
      ]
    );
    return this.normalizeKnowledgeIntakeRecord(result.rows[0]);
  }

  async listKnowledgeIntakeRecords(): Promise<KnowledgeIntakeRecord[]> {
    if (!this.connected) return [];
    const result = await this.pool!.query(
      `SELECT * FROM ${SCHEMA}.knowledge_intake_records ORDER BY created_at DESC`
    );
    return result.rows.map(row => this.normalizeKnowledgeIntakeRecord(row));
  }

  async getKnowledgeIntakeRecord(id: number): Promise<KnowledgeIntakeRecord | null> {
    if (!this.connected) return null;
    const result = await this.pool!.query(
      `SELECT * FROM ${SCHEMA}.knowledge_intake_records WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.normalizeKnowledgeIntakeRecord(result.rows[0]) : null;
  }

  async markKnowledgeIntakeRecordIngested(
    id: number,
    ingestionResult: Record<string, any>
  ): Promise<KnowledgeIntakeRecord> {
    this.ensureConnected();
    const result = await this.pool!.query(
      `UPDATE ${SCHEMA}.knowledge_intake_records
       SET status = 'ingested',
           ingestion_result = $2::jsonb,
           read_only = TRUE,
           role = COALESCE($3, role),
           category = COALESCE($4, category),
           sub_category = COALESCE($5, sub_category),
           company = COALESCE($6, company),
           project = COALESCE($7, project),
           commodity = COALESCE($8, commodity),
           tags = COALESCE($9::jsonb, tags),
           ingested_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        JSON.stringify(ingestionResult || {}),
        ingestionResult.role || null,
        ingestionResult.category || null,
        ingestionResult.subCategory || null,
        ingestionResult.company || null,
        ingestionResult.project || null,
        ingestionResult.commodity || null,
        JSON.stringify(ingestionResult.tags || []),
      ]
    );
    if (!result.rows[0]) throw new Error('Knowledge intake record not found');
    return this.normalizeKnowledgeIntakeRecord(result.rows[0]);
  }

  async setKnowledgeIntakeRecordStatus(
    id: number,
    status: KnowledgeIntakeRecord['status'],
    updates: Partial<Pick<KnowledgeIntakeRecord, 'role' | 'category' | 'sub_category' | 'company' | 'project' | 'commodity' | 'tags'>> = {}
  ): Promise<KnowledgeIntakeRecord> {
    this.ensureConnected();
    const result = await this.pool!.query(
      `UPDATE ${SCHEMA}.knowledge_intake_records
       SET status = $2,
           role = COALESCE($3, role),
           category = COALESCE($4, category),
           sub_category = COALESCE($5, sub_category),
           company = COALESCE($6, company),
           project = COALESCE($7, project),
           commodity = COALESCE($8, commodity),
           tags = COALESCE($9::jsonb, tags),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        updates.role || null,
        updates.category || null,
        updates.sub_category || null,
        updates.company || null,
        updates.project || null,
        updates.commodity || null,
        JSON.stringify(updates.tags || []),
      ]
    );
    if (!result.rows[0]) throw new Error('Knowledge intake record not found');
    return this.normalizeKnowledgeIntakeRecord(result.rows[0]);
  }

  /**
   * Delete a document and all its chunks by source path.
   */
  async deleteDocument(sourcePath: string): Promise<boolean> {
    if (!this.connected) return false;

    const result = await this.pool!.query(
      `DELETE FROM ${SCHEMA}.documents WHERE source_path = $1`,
      [sourcePath]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get stats about the knowledge base.
   */
  async getStats(): Promise<{ documents: number; chunks: number; embeddingModel: string }> {
    if (!this.connected) return { documents: 0, chunks: 0, embeddingModel: config.embeddingModel };

    const docCount = await this.pool!.query(`SELECT COUNT(*) FROM ${SCHEMA}.documents`);
    const chunkCount = await this.pool!.query(`SELECT COUNT(*) FROM ${SCHEMA}.chunks`);

    return {
      documents: parseInt(docCount.rows[0].count),
      chunks: parseInt(chunkCount.rows[0].count),
      embeddingModel: config.embeddingModel,
    };
  }

  /**
   * Check if a document has already been ingested (by source_path and optional file_hash).
   */
  async isDocumentIngested(sourcePath: string, fileHash?: string): Promise<boolean> {
    if (!this.connected) return false;

    if (fileHash) {
      const result = await this.pool!.query(
        `SELECT 1 FROM ${SCHEMA}.documents WHERE source_path = $1 AND file_hash = $2`,
        [sourcePath, fileHash]
      );
      return result.rows.length > 0;
    }

    const result = await this.pool!.query(
      `SELECT 1 FROM ${SCHEMA}.documents WHERE source_path = $1`,
      [sourcePath]
    );
    return result.rows.length > 0;
  }

  /**
   * Graceful shutdown.
   */
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.tunnelServer) {
      this.tunnelServer.close();
      this.tunnelServer = null;
    }
    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }
    this.connected = false;
    console.log('[VectorService] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  private normalizeKnowledgeIntakeRecord(row: any): KnowledgeIntakeRecord {
    return {
      ...row,
      tags: Array.isArray(row.tags) ? row.tags : [],
      suggested_tags: Array.isArray(row.suggested_tags) ? row.suggested_tags : [],
      source_metadata: row.source_metadata || {},
      ingestion_result: row.ingestion_result || {},
      content_preview: row.content_preview || '',
      read_only: Boolean(row.read_only),
    };
  }

  private ensureConnected(): void {
    if (!this.connected || !this.pool) {
      throw new Error('Knowledge database is not connected. Check PostgreSQL/pgvector connectivity first.');
    }
  }
}

export const vectorService = new VectorService();
