import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export default function useSocket() {
  const [socket, setSocket] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);

  useEffect(() => {
    const newSocket = io(import.meta.env.VITE_WS_URL);
    newSocket.on('message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });
    setSocket(newSocket);
    return () => newSocket.disconnect();
  }, []);

  const sendMessage = (type: string, content: any) => {
    socket.emit('message', { type, content });
  };

  return { messages, sendMessage };
}