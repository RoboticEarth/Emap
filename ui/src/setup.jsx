import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

function Setup() {
    const [monitors, setMonitors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        loadMonitors();
    }, []);

    async function loadMonitors() {
        setLoading(true);
        try {
            const res = await fetch('/api/monitors');
            const data = await res.json();
            setMonitors(data);
        } catch (e) {
            setError('Failed to load monitors');
        }
        setLoading(false);
    }

    async function selectMonitor(id) {
        try {
            await fetch('/api/config/monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ control_panel_monitor_id: id })
            });
            alert("Control Panel Monitor Saved!");
        } catch (e) {
            alert("Failed to save monitor selection.");
        }
    }

    return (
        <div className="flex flex-col items-center justify-center h-screen space-y-8 bg-zinc-900 text-white font-sans">
            <img src="/robotic T M.png" alt="Logo" className="w-64" />
            <h1 className="text-2xl font-bold">Multi-Monitor Setup</h1>
            <p className="text-gray-400">Select the monitor you want to be your Control Panel.</p>
            
            <div id="monitor-list" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {loading && <div className="animate-pulse text-gray-500 text-center col-span-2">Detecting monitors...</div>}
                {error && <div className="text-red-500 text-center col-span-2">{error}</div>}
                {!loading && !error && monitors.map((m, index) => (
                    <button 
                        key={m.id || index}
                        onClick={() => selectMonitor(m.id)}
                        className="px-6 py-4 bg-zinc-800 hover:bg-blue-600 border border-zinc-700 rounded-xl transition-all flex flex-col items-center min-w-[200px] group"
                    >
                        <span className="text-lg font-bold group-hover:text-white">Monitor {index + 1}</span>
                        <span className="text-xs text-gray-400 mt-1">{m.width}x{m.height} at {m.x},{m.y}</span>
                        <span className="text-[10px] text-gray-500 font-mono mt-2">ID: {m.id}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Setup />
    </React.StrictMode>
);