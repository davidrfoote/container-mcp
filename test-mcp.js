const http = require('http');

// Open SSE connection
const sseReq = http.get('http://localhost:9000/sse', (res) => {
  let sessionId = null;
  
  res.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const match = line.match(/sessionId=([a-f0-9-]+)/);
        if (match) {
          sessionId = match[1];
          console.log('Got sessionId:', sessionId);
          
          // Send initialize
          sendMsg(sessionId, {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1.0'}}});
          
          setTimeout(() => {
            // Send initialized notification
            sendMsg(sessionId, {jsonrpc:'2.0',method:'notifications/initialized'});
            
            setTimeout(() => {
              // Call get_repo_state
              sendMsg(sessionId, {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_repo_state',arguments:{working_dir:'/home/david/dev-session-app'}}});
            }, 200);
          }, 200);
        }
      }
      if (line.startsWith('data:') && sessionId) {
        try {
          const data = JSON.parse(line.slice(5).trim());
          console.log('SSE response:', JSON.stringify(data, null, 2));
          if (data.id === 2) {
            setTimeout(() => { process.exit(0); }, 100);
          }
        } catch {}
      }
    }
  });
});

function sendMsg(sessionId, body) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: 'localhost', port: 9000, path: `/messages?sessionId=${sessionId}`,
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}
  }, (res) => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { if (b.trim()) console.log('POST response:', b.trim()); });
  });
  req.write(data);
  req.end();
}

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
