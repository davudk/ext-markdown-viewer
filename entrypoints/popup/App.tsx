import './App.css';

function App() {
  return (
    <div className="popup">
      <h1>Markdown Viewer</h1>
      <p>
        Open any <code>.md</code> file and it renders automatically.
      </p>
      <p className="hint">
        For local files, enable <strong>Allow access to file URLs</strong> on
        this extension's details page.
      </p>
    </div>
  );
}

export default App;
