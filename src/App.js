import React, { useState } from "react";
import KinesisComponent from "./kinesis_component";
import "./App.css";

function App() {
  const [showButton, setShowButton] = useState(false);
  return (
    <div className="App">
      {showButton ? (
        <>
          <button className="btn" onClick={() => setShowButton(false)}>
            Close Streaming
          </button>
          <KinesisComponent />
        </>
      ) : (
        <button className="btn" onClick={() => setShowButton(true)}>
          Start Streaming
        </button>
      )}
    </div>
  );
}

export default App;
