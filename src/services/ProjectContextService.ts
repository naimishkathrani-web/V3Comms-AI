import { Pool } from 'pg';

export interface ProjectNode {
  id: string;           // UUID
  parent_id: string | null;  // null for root (project)
  node_type: 'project' | 'session' | 'thread' | 'message';
  name: string;
  embedding?: number[];  // For semantic search within project
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProjectNode {
  parent_id?: string | null;
  node_type: 'project' | 'session' | 'thread' | 'message';
  name: string;
  metadata?: Record<string, any>;
}

class ProjectContextService {
  private pool: Pool | null = null;
  private initialized = false;

  setPool(pool: Pool) {
    this.pool = pool;
  }

  async initialize(): Promise<void> {
    if (!this.pool || this.initialized) return;

    try {
      // Create projects table with tree structure
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS v3knowledge.projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          parent_id UUID REFERENCES v3knowledge.projects(id) ON DELETE CASCADE,
          node_type VARCHAR(20) NOT NULL CHECK (node_type IN ('project', 'session', 'thread', 'message')),
          name VARCHAR(255) NOT NULL,
          embedding vector(768),
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_projects_parent ON v3knowledge.projects(parent_id);
        CREATE INDEX IF NOT EXISTS idx_projects_type ON v3knowledge.projects(node_type);
        CREATE INDEX IF NOT EXISTS idx_projects_embedding ON v3knowledge.projects USING ivfflat (embedding vector_cosine_ops);
      `);

      this.initialized = true;
      console.log('[ProjectContextService] Projects table initialized');
    } catch (error: any) {
      console.error('[ProjectContextService] Initialization failed:', error.message);
    }
  }

  async createNode(data: CreateProjectNode): Promise<ProjectNode> {
    if (!this.pool) throw new Error('Pool not initialized');

    const { parent_id, node_type, name, metadata } = data;
    const result = await this.pool.query(
      `INSERT INTO v3knowledge.projects (parent_id, node_type, name, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [parent_id || null, node_type, name, JSON.stringify(metadata || {})]
    );

    return result.rows[0];
  }

  async getNode(id: string): Promise<ProjectNode | null> {
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'SELECT * FROM v3knowledge.projects WHERE id = $1',
      [id]
    );

    return result.rows[0] || null;
  }

  async getChildren(parentId: string | null): Promise<ProjectNode[]> {
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      `SELECT * FROM v3knowledge.projects 
       WHERE parent_id $1 
       ORDER BY created_at DESC`,
      [parentId || null]
    );

    return result.rows;
  }

  async getTree(rootId: string): Promise<ProjectNode[]> {
    if (!this.pool) throw new Error('Pool not initialized');

    // Recursive CTE to get full tree
    const result = await this.pool.query(`
      WITH RECURSIVE tree AS (
        SELECT * FROM v3knowledge.projects WHERE id = $1
        UNION ALL
        SELECT p.* FROM v3knowledge.projects p
        INNER JOIN tree t ON p.parent_id = t.id
      )
      SELECT * FROM tree ORDER BY created_at
    `, [rootId]);

    return result.rows;
  }

  async updateNode(id: string, updates: Partial<CreateProjectNode>): Promise<ProjectNode | null> {
    if (!this.pool) throw new Error('Pool not initialized');

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(updates.name);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.parent_id !== undefined) {
      fields.push(`parent_id = $${idx++}`);
      values.push(updates.parent_id || null);
    }

    if (fields.length === 0) return this.getNode(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE v3knowledge.projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  async deleteNode(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'DELETE FROM v3knowledge.projects WHERE id = $1',
      [id]
    );

    return (result.rowCount || 0) > 0;
  }

  async searchWithinProject(projectId: string, query: string, limit = 5): Promise<ProjectNode[]> {
    if (!this.pool) throw new Error('Pool not initialized');

    // Get embedding for query (would need embedding service)
    // For now, do text-based search
    const result = await this.pool.query(`
      SELECT * FROM v3knowledge.projects
      WHERE id = $1 OR parent_id IN (
        WITH RECURSIVE descendants AS (
          SELECT id FROM v3knowledge.projects WHERE id = $1
          UNION ALL
          SELECT p.id FROM v3knowledge.projects p
          INNER JOIN descendants d ON p.parent_id = d.id
        )
        SELECT id FROM descendants
      )
      AND name ILIKE $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [projectId, `%${query}%`, limit]);

    return result.rows;
  }

  async listProjects(): Promise<ProjectNode[]> {
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      `SELECT * FROM v3knowledge.projects 
       WHERE node_type = 'project' 
       ORDER BY updated_at DESC`
    );

    return result.rows;
  }
}

export const projectContextService = new ProjectContextService();
