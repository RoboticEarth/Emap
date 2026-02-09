import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

function Dashboard() {
    return (
        <div className="bg-zinc-900 text-white flex items-center justify-center h-screen font-sans">
            <div className="text-center">
                <h1 className="text-4xl font-bold text-blue-500 mb-4">Dashboard</h1>
                <p className="text-gray-400">Control Panel Placeholder</p>
            </div>
        </div>
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Dashboard />
    </React.StrictMode>
);