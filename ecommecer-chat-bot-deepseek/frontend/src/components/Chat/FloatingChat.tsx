import { useState, useEffect } from 'react';
import { useSocket } from '../../hooks/useSocket';
import MessageBubble from './MessageBubble';
import FileUpload from './FileUpload';

export default function FloatingChat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useSocket();

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
      </div>
      <FileUpload onUpload={file => sendMessage('file', file)} />
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyUp={(e) => e.key === 'Enter' && sendMessage('text', input)}
      />
    </div>
  );
}