const { Client: SSHClient } = require('ssh2');
const net = require('net');

const LOCAL_PORT = 15432;

const ssh = new SSHClient();

ssh.on('ready', () => {
  console.log('[SSH Tunnel] Connected to 103.180.236.49:22');

  const server = net.createServer((socket) => {
    ssh.forwardOut(
      socket.remoteAddress,
      socket.remotePort,
      '127.0.0.1',
      5432,
      (err, stream) => {
        if (err) {
          console.log('[SSH Tunnel] Forward error:', err.message);
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

  server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[SSH Tunnel] Listening on 127.0.0.1:${LOCAL_PORT} -> 103.180.236.49:5432`);
    console.log('[SSH Tunnel] Keep this terminal open. Press Ctrl+C to stop.');
  });

  server.on('error', (err) => {
    console.log('[SSH Tunnel] Server error:', err.message);
  });
});

ssh.on('error', (e) => {
  console.log('[SSH Tunnel] SSH error:', e.message);
  process.exit(1);
});

ssh.on('close', () => {
  console.log('[SSH Tunnel] Connection closed');
  process.exit(0);
});

ssh.connect({
  host: '103.180.236.49',
  port: 22,
  username: 'Administrator',
  password: 'Aallu#1324',
  readyTimeout: 15000,
  keepaliveInterval: 30000,
});
