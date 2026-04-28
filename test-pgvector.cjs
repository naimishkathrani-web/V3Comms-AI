const { Client: SSHClient } = require('ssh2');
const { Client: PGClient } = require('pg');
const net = require('net');

const sshConfig = {
  host: '103.180.236.49',
  port: 22,
  username: 'Administrator',
  password: 'Aallu#1324',
  readyTimeout: 15000,
};

const LOCAL_PORT = 15432;
const REMOTE_HOST = '127.0.0.1';
const REMOTE_PORT = 5432;

const ssh = new SSHClient();

ssh.on('ready', () => {
  console.log('SSH connected! Creating local tunnel on port ' + LOCAL_PORT);

  const server = net.createServer((socket) => {
    ssh.forwardOut(socket.remoteAddress, socket.remotePort, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
      if (err) {
        console.log('Forward error:', err.message);
        socket.end();
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('close', () => stream.end());
      stream.on('close', () => socket.end());
    });
  });

  server.listen(LOCAL_PORT, '127.0.0.1', async () => {
    console.log('Local tunnel listening on 127.0.0.1:' + LOCAL_PORT);

    // Now connect pg through the local tunnel
    const pg = new PGClient({
      host: '127.0.0.1',
      port: LOCAL_PORT,
      database: 'V3CommsAI',
      user: 'postgres',
      password: 'Shreeji#1324',
      connectionTimeoutMillis: 10000,
    });

    try {
      await pg.connect();
      console.log('PostgreSQL connected through SSH tunnel!');

      await pg.query('CREATE EXTENSION IF NOT EXISTS vector');
      const res = await pg.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'");
      console.log('pgvector:', JSON.stringify(res.rows));

      const tables = await pg.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      console.log('Existing tables:', JSON.stringify(tables.rows));

      await pg.end();
    } catch (e) {
      console.log('PG Error:', e.message);
    }

    server.close();
    ssh.end();
  });
});

ssh.on('error', (e) => {
  console.log('SSH Error:', e.message);
});

ssh.connect(sshConfig);
