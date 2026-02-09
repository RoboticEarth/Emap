import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

function Projection() {
    return (
        <div className="bg-black text-white flex items-center justify-center h-screen font-sans">
            <div className="text-center">
                <h1 className="text-4xl font-bold text-green-500 mb-4">Projection</h1>
                <p className="text-gray-400">Map Output Placeholder</p>
            </div>
        </div>
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Projection />
    </React.StrictMode>
);