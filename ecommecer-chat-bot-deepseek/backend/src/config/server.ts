import { Server } from 'socket.io';
import http from 'http';

export const createServer = () => {
  const server = http.createServer();
  const io = new Server(server, { 
    cors: { 
      origin: '*' 
    }
  });

  return { server, io };
};