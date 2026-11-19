import app from './server.js';
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '127.0.0.1', () => console.log(`SmartOps listening at http://localhost:${port}`));
server.on('error',error=>{console.error('无法启动 SmartOps：',error.code);process.exitCode=1;});
