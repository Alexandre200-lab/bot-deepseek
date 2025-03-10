export default function MessageBubble({ message }) {
  return (
    <div className={`message ${message.isBot ? 'bot' : 'user'}`}>
      {message.content}
    </div>
  );
}