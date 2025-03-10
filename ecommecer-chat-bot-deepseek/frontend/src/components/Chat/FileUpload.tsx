export default function FileUpload({ onUpload }) {
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (file) onUpload(file);
  };

  return (
    <div className="file-upload">
      <input type="file" onChange={handleFile} />
    </div>
  );
}