import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './components/Icons';
import { db } from './lib/persistence';
import { solveHomography, applyHomography, getCssMatrix, getDistance } from './lib/math';
import { ProceduralLib } from './lib/procedural';
import { ColorUtils } from './lib/color';

const { 
    Settings, Calculator, Move3d, Eye, EyeOff, Plus, Trash2, Target, 
    Rotate3D, Ruler, Box: BoxIcon, Move, Grid3X3, QrCode, Folder, 
    ChevronRight, ChevronDown, ChevronUp, Palette, CheckCircle, 
    Axis3d, MousePointer2, Clapperboard, Image: ImageIcon, Upload, 
    Play, SkipBack, SkipForward, LayoutTemplate, MonitorOff, Film, 
    Timer, Activity, Layers, Workflow, Link, X, Cable, Maximize, 
    AlertTriangle, HardDrive, Database, Video, Blend, File, FolderPlus 
} = Icons;

// --- SHARED UI COMPONENTS ---

const ConflictModal = ({ isOpen, fileName, onKeepOld, onKeepNew, applyToAll, setApplyToAll }) => {
    if (!isOpen) return null;
    return createPortal(
        <div className="fixed inset-0 z-[30000] flex items-center justify-center bg-black/70 backdrop-blur-md">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 w-[400px] flex flex-col gap-4 animate-scale">
                <div className="flex items-center gap-3 text-orange-400">
                    <AlertTriangle size={24} />
                    <h3 className="text-lg font-bold text-white uppercase">File Conflict</h3>
                </div>
                <p className="text-sm text-gray-300">
                    The file <span className="text-white font-bold">"{fileName}"</span> already exists in the library.
                </p>
                
                <div className="bg-zinc-800 p-3 rounded border border-zinc-700 space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer group">
                        <input type="checkbox" checked={applyToAll} onChange={e => setApplyToAll(e.target.checked)} className="form-checkbox h-4 w-4 text-blue-600 bg-zinc-700 border-zinc-600 rounded" />
                        <span className="text-xs font-bold text-gray-400 group-hover:text-gray-200">Apply choice to all remaining conflicts</span>
                    </label>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <button onClick={onKeepNew} className="w-full py-3 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-lg transition-all">
                        OVERWRITE (KEEP NEW)
                    </button>
                    <button onClick={onKeepOld} className="w-full py-3 rounded bg-zinc-800 hover:bg-zinc-700 text-gray-300 text-xs font-bold border border-zinc-700 transition-all">
                        SKIP (KEEP OLD)
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

const HandleCircle = ({ type, title, top, active, onClick }) => {
    let colorClasses = '';
    if (type === 'output') {
        colorClasses = '-right-3.5 bg-gray-600 border-gray-300 hover:bg-blue-500 hover:border-white';
    } else if (type === 'base') {
        colorClasses = '-left-3.5 bg-red-900 border-red-500 hover:bg-red-600';
    } else if (type === 'blend') {
        colorClasses = '-left-3.5 bg-green-900 border-green-500 hover:bg-green-600';
    } else {
        colorClasses = '-left-3.5 bg-lime-900 border-lime-500 hover:bg-lime-600';
    }

    return (
        <div 
            className={`absolute w-7 h-7 rounded-full border-2 cursor-pointer z-50 transition-all duration-200 flex items-center justify-center ${colorClasses} ${active ? 'bg-white border-blue-400 scale-125 shadow-[0_0_10px_rgba(59,130,246,0.8)]' : ''}`}
            style={{ top: `${top}px` }}
            title={title}
            data-handle={type}
            onClick={onClick} 
        >
            {active && <div className="w-3 h-3 rounded-full bg-blue-500"></div>}
        </div>
    );
};

const PointHandle = ({ x, y, index, color, isSelected, onDrag, isMoveMode }) => {
    const [isDragging, setIsDragging] = useState(false);
    useEffect(() => {
        if (isDragging) {
            const handleMouseMove = (e) => onDrag(index, e.clientX, e.clientY);
            const handleMouseUp = () => setIsDragging(false);
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            return () => {
                window.removeEventListener('mousemove', handleMouseMove);
                window.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [isDragging]);
    return (
        <g transform={`translate(${x}, ${y})`} style={{ cursor: isMoveMode ? 'move' : (isSelected ? 'move' : 'default') }} onMouseDown={(e) => { if(isSelected) { e.stopPropagation(); setIsDragging(true); } }} onClick={(e) => e.stopPropagation()}>
            <circle r="30" fill="transparent" />
            <circle r="12" fill={isMoveMode ? "#fb923c" : color} fillOpacity={isSelected ? 0.3 : 0.1} />
            <circle r={isSelected ? 6 : 4} fill={isMoveMode ? "#fb923c" : color} stroke="black" strokeWidth="1" />
            {isSelected && <text x="15" y="5" fill="white" fontSize="10" className="no-select font-mono pointer-events-none">P{index + 1}</text>}
        </g>
    );
};

const WarpedTextureGrid = ({ wallPoints }) => {
    const grid = useMemo(() => {
        const src = [{x:0, y:0}, {x:1, y:0}, {x:1, y:1}, {x:0, y:1}];
        const H = solveHomography(src, wallPoints);
        const cells = [];
        const gridSize = 10; 
        for(let y=0; y<gridSize; y++) {
            for(let x=0; x<gridSize; x++) {
                const u = x / gridSize; const v = y / gridSize;
                const u2 = (x+1) / gridSize; const v2 = (y+1) / gridSize;
                const p1 = applyHomography(H, u, v); 
                const p2 = applyHomography(H, u2, v); 
                const p3 = applyHomography(H, u2, v2); 
                const p4 = applyHomography(H, u, v2);
                const isWhite = (x + y) % 2 === 0;
                cells.push(<path key={`${x}-${y}`} d={`M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} L ${p4.x} ${p4.y} Z`} fill={isWhite ? "white" : "black"} stroke="none" />);
            }
        }
        return cells;
    }, [wallPoints]);
    return <g opacity="0.6">{grid}</g>;
};

const FileExplorer = ({ isOpen, onClose, onImport }) => {
    const [currentPath, setCurrentPath] = useState('');
    const [items, setItems] = useState([]);
    const [selectedPaths, setSelectedPaths] = useState([]);
    const [loading, setLoading] = useState(false);
    const [drives, setDrives] = useState([]);
    const [activeTab, setActiveTab] = useState('server'); // 'server' or drive path
    
    // Conflict state
    const [conflict, setConflict] = useState(null); // { path, name }
    const [applyToAll, setApplyToAll] = useState(false);
    const [bulkDecision, setBulkDecision] = useState(null); // 'overwrite' or 'skip'

    useEffect(() => {
        if (isOpen) {
            loadDrives();
            loadPath('');
        }
    }, [isOpen]);

    const loadDrives = async () => {
        const d = await db.getDrives();
        setDrives(d);
    };

    const loadPath = async (path) => {
        setLoading(true);
        try {
            const data = await db.listServerFiles(path);
            setCurrentPath(data.path);
            setItems(data.items || []);
            setSelectedPaths([]);
        } catch (e) {
            console.error(e);
        }
        setLoading(false);
    };

    const toggleSelect = (path) => {
        setSelectedPaths(prev => 
            prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
        );
    };

    const handleDeleteItem = async (e, path, name) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to permanently delete "${name}" from disk?`)) {
            setLoading(true);
            await db.deleteFileSystemItem(path);
            await loadPath(currentPath);
            setLoading(false);
        }
    };

    const selectAll = () => {
        const allFiles = items.filter(i => i.type === 'file').map(i => i.path);
        setSelectedPaths(allFiles);
    };

    const handleImportProcess = async () => {
        setLoading(true);
        let currentBulkDecision = null;

        for (const path of selectedPaths) {
            const fileName = path.split('/').pop() || path.split('\\').pop();
            
            if (currentBulkDecision) {
                if (currentBulkDecision === 'overwrite') {
                    await db.importAssetFromPath(path, true);
                }
                continue;
            }

            const result = await db.importAssetFromPath(path, false);
            
            if (result && result.conflict) {
                // Wait for user decision
                const decision = await new Promise((resolve) => {
                    setConflict({ path, name: fileName, resolve });
                });
                
                setConflict(null);
                
                if (decision === 'overwrite') {
                    await db.importAssetFromPath(path, true);
                    if (applyToAll) currentBulkDecision = 'overwrite';
                } else {
                    if (applyToAll) currentBulkDecision = 'skip';
                }
            }
        }
        
        setLoading(false);
        onImport();
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[210] bg-black/80 backdrop-blur-sm flex items-center justify-center p-8">
            <ConflictModal 
                isOpen={!!conflict} 
                fileName={conflict?.name} 
                applyToAll={applyToAll}
                setApplyToAll={setApplyToAll}
                onKeepOld={() => conflict?.resolve('skip')}
                onKeepNew={() => conflict?.resolve('overwrite')}
            />
            
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl h-[80vh] flex flex-col shadow-2xl overflow-hidden">
                <div className="p-4 border-b border-zinc-700 flex justify-between items-center bg-zinc-950">
                    <h2 className="text-lg font-bold text-white flex items-center gap-2"><HardDrive size={20} className="text-blue-400"/> File Explorer</h2>
                    <div className="flex items-center gap-2">
                        {selectedPaths.length > 0 && (
                            <span className="text-xs font-bold text-blue-400 mr-4">{selectedPaths.length} selected</span>
                        )}
                        <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={24}/></button>
                    </div>
                </div>

                <div className="flex bg-zinc-950 border-b border-zinc-800">
                    <button 
                        onClick={() => { setActiveTab('server'); loadPath(''); }}
                        className={`px-6 py-3 text-xs font-bold transition-colors ${activeTab === 'server' ? 'text-blue-400 border-b-2 border-blue-400 bg-zinc-900' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        SERVER ASSETS
                    </button>
                    {drives.map(drive => (
                        <button 
                            key={drive.path}
                            onClick={() => { setActiveTab(drive.path); loadPath(drive.path); }}
                            className={`px-6 py-3 text-xs font-bold transition-colors flex items-center gap-2 ${activeTab === drive.path ? 'text-orange-400 border-b-2 border-orange-400 bg-zinc-900' : 'text-gray-500 hover:text-gray-300'}`}
                        >
                            <Cable size={14} /> USB: {drive.name}
                        </button>
                    ))}
                </div>

                <div className="p-2 bg-zinc-900/50 flex justify-between items-center border-b border-zinc-800">
                    <div className="text-[10px] text-gray-500 font-mono truncate px-2">{currentPath || 'Root'}</div>
                    <div className="flex gap-2">
                        <button onClick={selectAll} className="text-[10px] font-bold text-blue-400 hover:text-blue-300 px-2 py-1">Select All</button>
                        <button onClick={() => setSelectedPaths([])} className="text-[10px] font-bold text-gray-500 hover:text-gray-300 px-2 py-1">Clear</button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4">
                    {loading && !conflict ? <div className="text-center p-8 flex flex-col items-center gap-4">
                        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-gray-500 text-xs font-bold animate-pulse uppercase tracking-widest">Processing Files...</span>
                    </div> : (
                        <div className="grid grid-cols-4 md:grid-cols-5 gap-3">
                            {items.map((item, i) => ( 
                                <div 
                                    key={i} 
                                    onClick={() => item.type === 'file' ? toggleSelect(item.path) : loadPath(item.path)} 
                                    className={`flex flex-col items-center p-2 rounded-lg cursor-pointer transition-all relative ${selectedPaths.includes(item.path) ? 'bg-blue-600/20 ring-2 ring-blue-500' : 'hover:bg-zinc-800'}`}
                                > 
                                    {selectedPaths.includes(item.path) && (
                                        <div className="absolute top-1 right-1 bg-blue-500 text-white rounded-full p-0.5 z-10">
                                            <CheckCircle size={14} />
                                        </div>
                                    )}
                                    <div className="w-full aspect-square bg-black mb-2 flex items-center justify-center overflow-hidden rounded-md border border-zinc-800 shadow-inner group/item relative">
                                        {item.type === 'file' ? ( 
                                            <img 
                                                src={`/api/asset/${encodeURIComponent(item.name)}`} 
                                                className="w-full h-full object-cover" 
                                                onError={(e) => {e.target.style.display='none'; e.target.nextSibling.style.display='block'}}
                                            /> 
                                        ) : null}
                                        <div style={{display: item.type === 'file' ? 'none' : 'block'}}>
                                            {item.type === 'dir' || item.type === 'drive' ? ( 
                                                <Folder size={40} className={item.type === 'drive' ? "text-orange-400" : "text-yellow-500 shadow-lg"} /> 
                                            ) : ( 
                                                <File size={40} className="text-zinc-600" /> 
                                            )}
                                        </div>
                                        {/* Quick Delete for files/dirs (not drives) */}
                                        {item.type !== 'drive' && (
                                            <button 
                                                onClick={(e) => handleDeleteItem(e, item.path, item.name)}
                                                className="absolute top-1 left-1 p-1 bg-red-600/80 hover:bg-red-600 text-white rounded opacity-0 group-hover/item:opacity-100 transition-opacity z-20"
                                                title="Delete from disk"
                                            >
                                                <Trash2 size={12}/>
                                            </button>
                                        )}
                                    </div>
                                    <span className="text-[10px] font-bold text-gray-300 truncate w-full text-center px-1" title={item.name}>{item.name}</span> 
                                </div> 
                            ))}
                            {items.length === 0 && <div className="col-span-full text-center p-12 text-gray-600 text-xs font-bold uppercase tracking-widest opacity-50">Empty Directory</div>}
                        </div>
                    )}
                </div>
                
                <div className="p-4 border-t border-zinc-800 bg-zinc-950 flex justify-between items-center">
                    <div className="text-[10px] text-gray-500 font-bold uppercase">
                        {selectedPaths.length} items selected
                    </div>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 py-2 rounded text-xs font-bold text-gray-500 hover:text-white transition-colors">CANCEL</button>
                        <button 
                            onClick={handleImportProcess} 
                            disabled={selectedPaths.length === 0 || loading} 
                            className="px-8 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-blue-900/20 transition-all active:scale-95 uppercase tracking-widest"
                        >
                            {activeTab === 'server' ? 'IMPORT TO PROJECT' : 'IMPORT TO ASSETS'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const AssetBrowser = ({ isOpen, onClose, onSelect, showConfirm, showAlert, initialTab = 'image' }) => {

    const [activeTab, setActiveTab] = useState(initialTab);

    const [assets, setAssets] = useState([]);

    const [showFileExplorer, setShowFileExplorer] = useState(false);



    useEffect(() => {

        if (isOpen) {

            setActiveTab(initialTab);

            loadAssets();

        }

    }, [isOpen, initialTab]);



    const loadAssets = async () => {

        const all = await db.getAllAssets();

        setAssets(all);

    };



    const handleImport = async () => {
        console.log("[IMPORT] Import finished, reloading assets...");
        await loadAssets();
    };

    const handleDelete = async (e, id) => {
        e.stopPropagation();
        showConfirm("Delete Asset", "Are you sure you want to delete this asset from the library?", async () => {
            await db.deleteAsset(id);
            await loadAssets();
        });
    };

    const filteredAssets = assets.filter(a => a.type === activeTab);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-8">
            <FileExplorer isOpen={showFileExplorer} onClose={() => setShowFileExplorer(false)} onImport={handleImport} />
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl overflow-hidden">
                <div className="p-4 border-b border-zinc-700 flex justify-between items-center bg-zinc-950">
                    <h2 className="text-lg font-bold text-white flex items-center gap-2"><Folder size={20} className="text-blue-400"/> Asset Library</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={24}/></button>
                </div>
                <div className="flex border-b border-zinc-800 bg-zinc-900">
                    {initialTab === 'image' && (
                        <button onClick={() => setActiveTab('image')} className={`flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 ${activeTab === 'image' ? 'text-blue-400 border-b-2 border-blue-400 bg-zinc-800/50' : 'text-gray-500 hover:text-gray-300'}`}>
                            <ImageIcon size={16}/> Images
                        </button>
                    )}
                    {initialTab === 'video' && (
                        <button onClick={() => setActiveTab('video')} className={`flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 ${activeTab === 'video' ? 'text-pink-400 border-b-2 border-pink-400 bg-zinc-800/50' : 'text-gray-500 hover:text-gray-300'}`}>
                            <Video size={16}/> Videos
                        </button>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-4 bg-zinc-900/50">
                    <div className="grid grid-cols-4 md:grid-cols-5 gap-4">
                        <div onClick={() => setShowFileExplorer(true)} className="aspect-square border-2 border-dashed border-zinc-700 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 hover:bg-zinc-800 transition-colors group">
                            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mb-2 group-hover:bg-blue-600 transition-colors">
                                <HardDrive size={24} className="text-gray-400 group-hover:text-white"/>
                            </div>
                            <span className="text-xs font-bold text-gray-500 group-hover:text-gray-300">Browse Server</span>
                        </div>
                                                        {filteredAssets.map(asset => (
                                                            <div key={asset.id} onClick={() => onSelect(asset)} className="aspect-square bg-black border border-zinc-700 rounded-lg overflow-hidden relative group cursor-pointer hover:ring-2 hover:ring-blue-500">
                                                                {asset.type === 'video' ? (
                                                                    <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-800">
                                                                        <Video size={48} className="text-zinc-600 mb-2" />
                                                                        <span className="text-[10px] text-zinc-500 font-bold uppercase">Video Asset</span>
                                                                    </div>
                                                                                                        ) : (
                                                                                                            <img src={asset.url} className="w-full h-full object-cover" loading="lazy" />
                                                                                                        )}                                                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">                                    <div className="absolute top-2 right-2">
                                        <button onClick={(e) => handleDelete(e, asset.id)} className="p-1.5 bg-red-600 rounded-md text-white hover:bg-red-500 shadow-lg" title="Delete Asset"><Trash2 size={14}/></button>
                                    </div>
                                    {onSelect && (
                                        <span className="bg-blue-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-transform">Select</span>
                                    )}
                                </div>
                                <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur px-2 py-1">
                                    <p className="text-[10px] text-gray-300 truncate">{asset.file.name}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

const LoadingScreen = () => (
    <div className="fixed inset-0 z-[9999] bg-black flex flex-col items-center justify-center">
        <div className="relative w-64">
            <img src="/robotic T M.png" alt="Logo" className="w-full relative z-10" />
            <div className="absolute inset-0 z-20 bg-gradient-to-r from-transparent via-white/50 to-transparent w-1/2 h-full -skew-x-12 blur-md animate-shimmer" style={{mixBlendMode: 'overlay'}}></div>
        </div>
        <div className="mt-8 text-white font-bold tracking-[0.2em] text-5xl animate-pulse">LOADING SYSTEM</div>
    </div>
);

const ProjectManager = ({ isOpen, onClose, activeProjectId, showConfirm, showAlert, setIsLoading }) => {
    const [projects, setProjects] = useState([]);
    const [newProjectName, setNewProjectName] = useState('');
    const [loading, setLoading] = useState(false);
    const [isGlobalLoading, setIsGlobalLoading] = useState(false);

    useEffect(() => {
        if (isOpen) loadProjects();
    }, [isOpen]);

    const loadProjects = async () => {
        setLoading(true);
        const list = await db.listProjects();
        setProjects(list);
        setLoading(false);
    };

    const handleCreate = async () => {
        if (!newProjectName.trim()) return;
        setIsGlobalLoading(true);
        try {
            await db.createProject(newProjectName);
            window.location.reload();
        } catch (e) {
            console.error(e);
            setIsGlobalLoading(false);
        }
    };

    const handleLoadProject = async (id) => {
        setIsGlobalLoading(true);
        try {
            await db.loadProject(id);
            // reload is handled inside loadProject
        } catch (e) {
            console.error(e);
            setIsGlobalLoading(false);
        }
    };

    const handleDeleteProject = async (id, name) => {
        showConfirm("Delete Project", `Are you sure you want to delete project "${name}"? This cannot be undone.`, async () => {
            setIsGlobalLoading(true);
            try {
                await db.deleteProject(id);
                if (id === activeProjectId) {
                    window.location.reload(); // Refresh to clear all state
                } else {
                    await loadProjects();
                    setIsGlobalLoading(false);
                }
            } catch (e) {
                console.error(e);
                setIsGlobalLoading(false);
            }
        });
    };

    // Can only close if there's an active project
    const canClose = onClose && activeProjectId !== null;

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[300] bg-black/90 backdrop-blur-md flex items-center justify-center p-8">
            {isGlobalLoading && <LoadingScreen />}
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md p-6 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2"><Database size={24} className="text-blue-500"/> Projects</h2>
                    <button 
                        onClick={() => {
                            showConfirm(
                                "Reset Monitor Setup", 
                                "This will restart the monitor configuration process on all screens. Continue?", 
                                () => {
                                    setIsLoading(true);
                                    db.resetMonitorConfig();
                                }
                            );
                        }}
                        className="bg-zinc-800 hover:bg-zinc-700 text-gray-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <MonitorOff size={14} /> Reselect Monitors
                    </button>
                </div>
                
                <div className="mb-6">
                    <label className="text-xs font-bold text-gray-500 mb-2 block">CREATE NEW PROJECT</label>
                    <div className="flex gap-2">
                        <input type="text" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="Project Name" className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-white outline-none focus:border-blue-500" />
                        <button onClick={handleCreate} disabled={loading || !newProjectName} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-bold disabled:opacity-50">Create</button>
                    </div>
                </div>

                <div className="border-t border-zinc-800 pt-4">
                    <label className="text-xs font-bold text-gray-500 mb-2 block">EXISTING PROJECTS</label>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                        {projects.map(p => (
                            <div key={p.id} className={`flex items-center justify-between p-3 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors group ${p.id === activeProjectId ? 'border border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.3)]' : ''}`}>
                                <div onClick={() => handleLoadProject(p.id)} className="flex-1 cursor-pointer">
                                    <span className="font-bold text-gray-200">{p.name}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button onClick={() => handleLoadProject(p.id)} className="text-xs text-gray-500 hover:text-white px-2 py-1">{p.id === activeProjectId ? 'Reload' : 'Load'}</button>
                                    <button onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteProject(p.id, p.name);
                                    }} className="text-gray-500 hover:text-red-400 p-1"><Trash2 size={14}/></button>
                                </div>
                            </div>
                        ))}
                        {projects.length === 0 && <div className="text-center text-gray-600 py-4 text-sm">No projects found. Create one to start.</div>}
                    </div>
                </div>
                {canClose && <button onClick={onClose} className="mt-6 w-full py-2 text-xs text-gray-500 hover:text-white">Cancel</button>}
            </div>
        </div>
    );
};                                    
                                            const NoiseCanvas = ({ type = 'perlin', scale = 5, detail = 4, time = 0, distortion = 0, isAnimating = false, animSpeed = 0.1 }) => {    const canvasRef = useRef(null);
    const timeOffsetRef = useRef(0);
    const lastFrameTimeRef = useRef(0);

    useEffect(() => {
        let animationFrameId;

        const render = (now) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            
            if (isAnimating) {
                const delta = now - (lastFrameTimeRef.current || now);
                timeOffsetRef.current += (delta / 1000) * animSpeed * 10;
                lastFrameTimeRef.current = now;
            }

            const ctx = canvas.getContext('2d', { alpha: false });
            const { width, height } = canvas;
            
            const imgData = ctx.createImageData(width, height);
            const data = imgData.data;
            const aspect = width / height;

            const currentTime = time + timeOffsetRef.current;

            for (let i = 0; i < data.length; i += 4) {
                let u = (i / 4) % width / width;
                let v = Math.floor((i / 4) / width) / height;
                u *= aspect;
                let x = u * scale;
                let y = v * scale;
                
                const t = currentTime * 0.1;
                
                if (distortion > 0) {
                    const warped = ProceduralLib.warp(x, y + t, distortion);
                    x = warped.x;
                    y = warped.y;
                }

                let val = 0;
                if (type === 'perlin') {
                    val = ProceduralLib.noise2D(x, y + t);
                    val = (val + 1) / 2; 
                } 
                else if (type === 'fbm') {
                    val = ProceduralLib.fbm(x, y + t, Math.floor(detail));
                } 
                else if (type === 'ridge') {
                    val = ProceduralLib.fbm(x, y + t, Math.floor(detail), 2, 0.5, 'ridge');
                }
                else if (type === 'worley') {
                    const vData = ProceduralLib.voronoi(x, y + t, 'euclidean');
                    val = 1.0 - Math.min(1, vData.distance); 
                }
                else if (type === 'cells') {
                    const vData = ProceduralLib.voronoi(x, y + t, 'euclidean');
                    val = vData.id; 
                }
                
                val = Math.max(0, Math.min(1, val));
                const color = val * 255;
                data[i] = color; data[i+1] = color; data[i+2] = color; data[i+3] = 255;     
            }
            ctx.putImageData(imgData, 0, 0);
            animationFrameId = requestAnimationFrame(render);
        };

        animationFrameId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(animationFrameId);
    }, [type, scale, detail, time, distortion, isAnimating, animSpeed]);

    return <canvas ref={canvasRef} width="256" height="256" style={{width: '100%', height: '100%', objectFit: 'cover'}} />;
};

const ColorPicker = ({ value, onChange, className }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [mode, setMode] = useState('grid'); 
    const [customColors, setCustomColors] = useState([]);
    const [hsv, setHsv] = useState({ h: 0, s: 0, v: 100 });

    useEffect(() => { const saved = localStorage.getItem('emap_custom_colors'); if (saved) setCustomColors(JSON.parse(saved)); }, []);
    useEffect(() => { if (isOpen) { const rgb = ColorUtils.hexToRgb(value); setHsv(ColorUtils.rgbToHsv(rgb.r, rgb.g, rgb.b)); } }, [isOpen, value]);

    const handleSaveColor = () => { if (!customColors.includes(value)) { const newColors = [...customColors, value].slice(-16); setCustomColors(newColors); localStorage.setItem('emap_custom_colors', JSON.stringify(newColors)); } };
    const updateFromHsv = (newHsv) => { setHsv(newHsv); const rgb = ColorUtils.hsvToRgb(newHsv.h, newHsv.s, newHsv.v); onChange(ColorUtils.rgbToHex(rgb.r, rgb.g, rgb.b)); };

    const gridColors = [
        ['#ffffff', '#e9ecef', '#dee2e6', '#ced4da', '#adb5bd', '#6c757d', '#495057', '#343a40', '#212529', '#000000'],
        ['#ffe3e3', '#ffc9c9', '#ffa8a8', '#ff8787', '#ff6b6b', '#fa5252', '#f03e3e', '#e03131', '#c92a2a', '#a61e4d'], 
        ['#ffdeeb', '#fcc2d7', '#faa2c1', '#f783ac', '#f06595', '#e64980', '#d6336c', '#c2255c', '#a61e4d', '#821135'], 
        ['#f3d9fa', '#eebefa', '#e599f7', '#da77f2', '#cc5de8', '#be4bdb', '#ae3ec9', '#9c36b5', '#862e9c', '#702459'], 
        ['#e5dbff', '#d0bfff', '#b197fc', '#9775fa', '#845ef7', '#7950f2', '#7048e8', '#6741d9', '#5f3dc4', '#52329e'], 
        ['#dbe4ff', '#bac8ff', '#91a7ff', '#748ffc', '#5c7cfa', '#4c6ef5', '#4263eb', '#3b5bdb', '#364fc7', '#2b3a55'], 
        ['#d0ebff', '#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#228be6', '#1c7ed6', '#1971c2', '#1864ab', '#0b3d91'], 
        ['#c5f6fa', '#99e9f2', '#66d9e8', '#3bc9db', '#22b8cf', '#15aabf', '#1098ad', '#0c8599', '#0b7285', '#085f66'], 
        ['#c3fae8', '#96f2d7', '#63e6be', '#38d9a9', '#20c997', '#12b886', '#0ca678', '#099268', '#087f5b', '#06664d'], 
        ['#d3f9d8', '#b2f2bb', '#8ce99a', '#69db7c', '#51cf66', '#40c057', '#37b24d', '#2f9e44', '#2b8a3e', '#237032'], 
        ['#fff3bf', '#ffec99', '#ffe066', '#ffd43b', '#fcc419', '#fab005', '#f59f00', '#f08c00', '#e67700', '#d9480f'], 
        ['#fff9db', '#fff3bf', '#ffec99', '#ffe066', '#ffd43b', '#fcc419', '#fab005', '#f59f00', '#f08c00', '#e67700'], 
    ];

    return (
        <>
            <div className={`relative ${className}`}>
                <div onClick={() => setIsOpen(true)} className="w-full h-full min-w-[20px] min-h-[20px] rounded border border-zinc-600 cursor-pointer shadow-sm flex items-center justify-center overflow-hidden" style={{backgroundColor: value}}></div>
            </div>
            {isOpen && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setIsOpen(false)}>
                    <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4 w-80 flex flex-col gap-4 animate-scale" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-center border-b border-zinc-700 pb-2">
                            <h3 className="text-sm font-bold text-white">Select Color</h3>
                            <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white"><X size={16}/></button>
                        </div>
                        <div className="flex border-b border-zinc-700 pb-2">
                            <button onClick={() => setMode('grid')} className={`flex-1 text-xs font-bold py-1 ${mode === 'grid' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}>Grid</button>
                            <button onClick={() => setMode('custom')} className={`flex-1 text-xs font-bold py-1 ${mode === 'custom' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}>Custom</button>
                        </div>
                        {mode === 'grid' && (
                            <div className="space-y-3">
                                <div className="grid grid-cols-10 gap-1.5">
                                    {gridColors.flat().map((c, i) => ( <div key={i} onClick={() => { onChange(c); setIsOpen(false); }} className="w-6 h-6 rounded-sm cursor-pointer hover:scale-125 transition-transform border border-transparent hover:border-white shadow-sm" style={{backgroundColor: c}} title={c}></div> ))}
                                </div>
                                {customColors.length > 0 && (
                                    <div className="pt-2 border-t border-zinc-800">
                                        <div className="text-[10px] text-gray-500 font-bold mb-1">SAVED</div>
                                        <div className="grid grid-cols-8 gap-1">
                                            {customColors.map((c, i) => ( <div key={i} onClick={() => { onChange(c); setIsOpen(false); }} className="w-6 h-6 rounded-full cursor-pointer hover:scale-110 transition-transform border border-zinc-700" style={{backgroundColor: c}} title={c}></div> ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        {mode === 'custom' && (
                            <div className="space-y-3">
                                <div className="w-full h-40 rounded-lg relative cursor-crosshair shadow-inner border border-zinc-700" style={{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)`, backgroundImage: 'linear-gradient(to right, #fff, transparent), linear-gradient(to top, #000, transparent)' }} onMouseDown={(e) => { const rect = e.target.getBoundingClientRect(); const handleMove = (ev) => { const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)); updateFromHsv({ ...hsv, s: x * 100, v: (1 - y) * 100 }); }; handleMove(e); const stop = () => { window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', stop); }; window.addEventListener('mousemove', handleMove); window.addEventListener('mouseup', stop); }}>
                                    <div className="absolute w-4 h-4 border-2 border-white rounded-full shadow-md pointer-events-none transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }}></div>
                                </div>
                                <div className="relative h-4 rounded-full overflow-hidden border border-zinc-700">
                                    <div className="absolute inset-0" style={{background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'}}></div>
                                    <input type="range" min="0" max="360" value={hsv.h} onChange={(e) => updateFromHsv({ ...hsv, h: parseFloat(e.target.value) })} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                                    <div className="absolute top-0 bottom-0 w-1 bg-white border border-gray-400 pointer-events-none" style={{left: `${(hsv.h / 360) * 100}%`}}></div>
                                </div>
                                <div className="flex gap-2">
                                    <div className="flex-1 bg-zinc-800 rounded px-2 py-1 flex items-center border border-zinc-700"><span className="text-gray-500 text-xs mr-1">#</span><input type="text" value={value.replace('#', '')} onChange={(e) => { const val = '#' + e.target.value; if (/^#[0-9A-F]{6}$/i.test(val)) onChange(val); }} className="bg-transparent border-none outline-none text-xs text-white w-full font-mono uppercase" /></div>
                                    <button onClick={handleSaveColor} className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-gray-300 rounded px-3 py-1 text-xs font-bold" title="Save to presets"><Plus size={14}/></button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
};

const CustomSelect = ({ value, onChange, options, className = "", buttonClassName = "bg-zinc-950 border-zinc-700 p-2" }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const selectedOption = options.find(opt => opt.value === value) || options[0];

    return (
        <div className={`relative ${className}`} ref={containerRef}>
            <div 
                className={`w-full text-sm rounded text-white font-medium cursor-pointer flex justify-between items-center border hover:border-zinc-500 transition-colors ${buttonClassName}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className="truncate">{selectedOption?.label || value}</span>
                <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''} ml-2 flex-shrink-0`} />
            </div>
            {isOpen && (
                <div className="absolute z-[100] w-full mt-1 bg-zinc-900 border border-zinc-700 rounded shadow-xl max-h-60 overflow-y-auto left-0 min-w-[100px]">
                    {options.map((opt) => (
                        <div key={opt.value} className={`px-3 py-2 text-xs cursor-pointer hover:bg-blue-600 hover:text-white transition-colors ${opt.value === value ? 'bg-zinc-800 text-blue-400' : 'text-gray-300'}`} onClick={(e) => { e.stopPropagation(); onChange(opt.value); setIsOpen(false); }}>
                            {opt.label}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// --- RENDER ENGINE ---

const RenderNode = ({ nodeId, nodes, connections, resolution, wallColor, isLive, isTransitioning }) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return null;

    const getStyle = () => {
        const fit = node.data.fit || 'cover';
        const scale = node.data.scale || 1;
        const rotate = node.data.rotate || 0;
        const alignX = node.data.alignX ?? 50;
        const alignY = node.data.alignY ?? 50;
        
        const isStretch = fit === 'fill';
        const originX = isStretch ? 50 : alignX;
        const originY = isStretch ? 50 : alignY;

        return {
            width: '100%', 
            height: '100%', 
            objectFit: fit,
            objectPosition: isStretch ? 'center' : `${alignX}% ${alignY}%`,
            transform: `scale(${scale}) rotate(${rotate}deg)`,
            transformOrigin: `${originX}% ${originY}%`,
        };
    };

    if (node.type === 'color') {
        return <div style={{width: '100%', height: '100%', position: 'relative', backgroundColor: node.data.value || 'black'}}></div>;
    }

    if (node.type === 'image' || node.type === 'video') {
        const style = getStyle();
        return (
            <div style={{width: '100%', height: '100%', position: 'relative', backgroundColor: isLive ? 'black' : 'transparent'}}>
                {node.type === 'image' && node.data.value && <img src={node.data.value} style={style} />}
                {node.type === 'video' && node.data.value && (
                    <video 
                        key={node.data.value} 
                        src={node.data.value} 
                        style={style} 
                        autoPlay 
                        loop 
                        muted={!(node.data.enableAudio ?? false)} 
                        playsInline 
                        crossOrigin="anonymous" 
                    />
                )}
            </div>
        );
    }

    if (node.type === 'noise') {
        return <NoiseCanvas 
            type={node.data.noiseType} 
            scale={node.data.scale} 
            detail={node.data.detail} 
            time={node.data.time} 
            distortion={node.data.distortion} 
            isAnimating={node.data.isAnimating}
            animSpeed={node.data.animSpeed}
        />;
    }

    if (node.type === 'mix') {
        const baseConn = connections.find(c => c.to === nodeId && c.toHandle === 'base');
        const blendConn = connections.find(c => c.to === nodeId && c.toHandle === 'blend');

        return (
            <div style={{position: 'relative', width: '100%', height: '100%'}}>
                <div style={{position: 'absolute', inset: 0}}>
                    {baseConn && <RenderNode nodeId={baseConn.from} nodes={nodes} connections={connections} resolution={resolution} wallColor={wallColor} isLive={isLive} isTransitioning={isTransitioning} />}
                </div>
                {blendConn && (
                    <div style={{
                        position: 'absolute', 
                        inset: 0, 
                        mixBlendMode: node.data.blendMode || 'normal'
                    }}>
                         <RenderNode nodeId={blendConn.from} nodes={nodes} connections={connections} resolution={resolution} wallColor={wallColor} isLive={isLive} isTransitioning={isTransitioning} />
                    </div>
                )}
            </div>
        );
    }

    return null;
};

const getInterpolatedNode = (prevNode, currNode, mix) => {
    const newData = { ...currNode.data };
    const keys = ['scale', 'alignX', 'alignY', 'rotate', 'opacity', 'distortion', 'detail', 'time', 'animSpeed'];
    keys.forEach(key => {
        let def = 0;
        if (key === 'scale') def = 1;
        if (key === 'alignX' || key === 'alignY') def = 50;
        if (key === 'detail') def = 4;
        if (key === 'animSpeed') def = 0.1;
        const v1 = prevNode.data[key] ?? def;
        const v2 = currNode.data[key] ?? def;
        if (typeof v1 === 'number' && typeof v2 === 'number') {
            newData[key] = v1 + (v2 - v1) * mix;
        }
    });
    return { ...currNode, data: newData };
};

const TransitioningProjectedContent = ({ prevCueState, currentCueState, mix, walls, isLive }) => {
    const getRootNodeId = (state, wallId) => {
        if (!state || !state.nodes) return null;
        const out = state.nodes.find(n => n.type === 'output' && n.data.wallId === wallId);
        if (!out) return null;
        const conn = state.connections?.find(c => c.to === out.id);
        return conn ? conn.from : null;
    };

    const isTransitioning = mix < 1 && !!prevCueState;

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {walls.map(wall => {
                const prevRootId = getRootNodeId(prevCueState, wall.id);
                const currRootId = getRootNodeId(currentCueState, wall.id);
                
                const p = wall.points;
                const width = Math.max(getDistance(p[0], p[1]), getDistance(p[2], p[3]));
                const height = Math.max(getDistance(p[1], p[2]), getDistance(p[3], p[0]));
                const cssM = getCssMatrix(wall.points, width, height);

                const isSameNode = prevRootId && currRootId && prevRootId === currRootId;
                
                let currentNodeToRender = null;
                if (currRootId) {
                    let nodesToUse = currentCueState.nodes;
                    if (isTransitioning && isSameNode) {
                        nodesToUse = currentCueState.nodes.map(n => {
                            const prev = prevCueState.nodes?.find(pn => pn.id === n.id);
                            return prev ? getInterpolatedNode(prev, n, mix) : n;
                        });
                    }
                    currentNodeToRender = (
                        <RenderNode 
                            nodeId={currRootId} 
                            nodes={nodesToUse} 
                            connections={currentCueState.connections} 
                            resolution={height} 
                            wallColor={wall.color} 
                            isLive={isLive} 
                            isTransitioning={isTransitioning} 
                        />
                    );
                }

                const currentLayerOpacity = (isTransitioning && !isSameNode) ? mix : 1;

                return (
                    <div key={wall.id} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ width: `${width}px`, height: `${height}px`, transform: cssM, overflow: 'hidden' }}>
                        {isTransitioning && !isSameNode && prevRootId && (
                            <div key={prevRootId} style={{ opacity: 1 - mix, position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                        <RenderNode nodeId={prevRootId} nodes={prevCueState.nodes} connections={prevCueState.connections} resolution={height} wallColor={wall.color} isLive={isLive} isTransitioning={isTransitioning} />
                            </div>
                        )}
                        {currentNodeToRender && (
                            <div key={currRootId} style={{ opacity: currentLayerOpacity, position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                {currentNodeToRender}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

const WallBackgroundLayer = ({ walls, currentCueState, isLive, isTransitioning, shouldShow }) => {
    if (isLive || isTransitioning || !shouldShow) return null;

    return (
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" style={{backgroundColor: 'transparent'}}>
            <defs>
                <pattern id="zebra-pattern" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="10" height="20" fill="currentColor"/>
                </pattern>
            </defs>
            {walls.map(wall => {
                const hasContent = currentCueState?.nodes?.some(n => 
                    n.type === 'output' && 
                    n.data.wallId === wall.id && 
                    currentCueState.connections?.some(c => c.to === n.id)
                );

                if (!hasContent) return null;

                return (
                    <g key={wall.id}>
                        <path d={`M ${wall.points[0].x} ${wall.points[0].y} L ${wall.points[1].x} ${wall.points[1].y} L ${wall.points[2].x} ${wall.points[2].y} L ${wall.points[3].x} ${wall.points[3].y} Z`} fill="url(#zebra-pattern)" className="zebra-pattern-path" color={wall.color} stroke="none" />
                    </g>
                );
            })}
        </svg>
    );
};

// --- NODE EDITOR ---

const Node = ({ id, type, x, y, label, selected, onDragStart, onHandleClick, data, updateData, isConnecting, activeConnectionId, onDelete, onOpenAssetBrowser }) => {
    const isMix = type === 'mix';
    const isMedia = type === 'image' || type === 'video';
    const isOutput = type === 'output';
    const isGenerator = type === 'noise';

    return (
        <div
            className={`absolute w-64 pb-2 rounded-lg border shadow-xl flex flex-col visible bg-zinc-800/95 backdrop-blur-sm ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-zinc-600'}`}
            style={{ transform: `translate(${x}px, ${y}px)` }}
        >
            <div 
                className={`px-3 py-2 rounded-t-lg text-xs font-bold uppercase flex justify-between items-center cursor-grab active:cursor-grabbing ${type === 'output' ? 'bg-lime-900 text-lime-200' : isMedia ? 'bg-purple-900 text-purple-200' : isMix ? 'bg-orange-900 text-orange-200' : 'bg-zinc-700 text-gray-300'}`}
                onMouseDown={(e) => { e.stopPropagation(); onDragStart(e, id); }}
            >
                <span className="flex items-center gap-2">
                    {type === 'image' && <ImageIcon size={14}/>}
                    {type === 'video' && <Video size={14}/>}
                    {type === 'color' && <Palette size={14}/>}
                    {type === 'noise' && <Activity size={14}/>}
                    {type === 'mix' && <Blend size={14}/>}
                    {type}
                </span>
                <div className="flex items-center gap-2">
                    {data?.name && <span className="truncate max-w-[100px] opacity-70" title={data.name}>{data.name}</span>}
                    {type !== 'output' && (
                        <button onClick={() => onDelete(id)} className="text-gray-500 hover:text-red-400 transition-colors" title="Delete Node">
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>
            
            <div className="p-3 space-y-3 cursor-default" onMouseDown={(e) => e.stopPropagation()}>
                <div className="text-sm font-bold text-gray-200">{label}</div>
                
                {type === 'color' && (
                    <div className="w-full h-10"><ColorPicker value={data?.value || '#ffffff'} onChange={(val) => updateData(id, { value: val })} className="w-full h-full" /></div>
                )}

                {type === 'mix' && (
                    <div>
                        <CustomSelect value={data?.blendMode || 'normal'} onChange={(val) => updateData(id, { blendMode: val })} buttonClassName="bg-zinc-950 border-zinc-600 p-3" options={[
                            { value: "normal", label: "Normal" },
                            { value: "multiply", label: "Multiply" },
                            { value: "screen", label: "Screen" },
                            { value: "overlay", label: "Overlay" },
                            { value: "darken", label: "Darken" },
                            { value: "lighten", label: "Lighten" },
                            { value: "difference", label: "Difference" },
                            { value: "add", label: "Add" }
                        ]} />
                    </div>
                )}
                
                {(type === 'image' || type === 'video') && (
                    <div className="space-y-2">
                        <div className="w-full h-24 bg-black border border-zinc-700 rounded overflow-hidden flex items-center justify-center relative group">
                            {data?.value ? (
                                type === 'video' ? <video src={data.value} className="w-full h-full object-contain" muted /> : <img src={data.value} className="w-full h-full object-contain" />
                            ) : (
                                <div className="text-gray-600 flex flex-col items-center"><Upload size={24}/></div>
                            )}
                            <button onClick={() => onOpenAssetBrowser(type, (asset) => updateData(id, { value: asset.url, assetId: asset.id, name: asset.file.name }))} className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center text-sm transition-opacity font-bold">
                                <Upload size={16} className="mr-2"/> Load Media
                            </button>
                        </div>
                    </div>
                )}
                
                {type === 'video' && (
                    <div className="pt-2 border-t border-zinc-700/50">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-gray-400 font-bold flex items-center gap-2">
                                <Activity size={12} className="text-pink-400" /> Enable Audio
                            </label>
                            <input 
                                type="checkbox" 
                                checked={data?.enableAudio ?? false} 
                                onChange={(e) => updateData(id, { enableAudio: e.target.checked })} 
                                className="form-checkbox h-4 w-4 text-pink-600 bg-zinc-800 border-zinc-600 rounded focus:ring-pink-500" 
                            />
                        </div>
                        <p className="text-[9px] text-gray-500 mt-1">Warning: Multiple audio sources may overlap.</p>
                    </div>
                )}

                {(type === 'image' || type === 'video') && (
                    <div className="space-y-2 border-t border-zinc-700 pt-2">
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-[10px] text-gray-500 font-bold block mb-1">Mode</label>
                                <CustomSelect value={data?.fit || 'cover'} onChange={(val) => updateData(id, { fit: val })} buttonClassName="bg-zinc-900 border-zinc-700 p-1 text-xs" options={[
                                    { value: "cover", label: "Cover (Zoom)" },
                                    { value: "contain", label: "Contain (Fit)" },
                                    { value: "fill", label: "Stretch" }
                                ]} />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 font-bold block mb-1">Scale: {data?.scale || 1}</label>
                                <input type="range" min="0.1" max="5" step="0.01" value={data?.scale ?? 1} onChange={(e) => updateData(id, { scale: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-500 font-bold block mb-1">Rotation: {data?.rotate || 0}°</label>
                            <input type="range" min="-180" max="180" step="1" value={data?.rotate ?? 0} onChange={(e) => updateData(id, { rotate: parseInt(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                        </div>
                        {data?.fit !== 'fill' && (
                            <div>
                                <label className="text-[10px] text-gray-500 font-bold block mb-1">Position ({data?.alignX ?? 50}%, {data?.alignY ?? 50}%)</label>
                                <div className="flex gap-2">
                                    <input type="range" min="0" max="100" value={data?.alignX ?? 50} onChange={(e) => updateData(id, { alignX: parseInt(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" title="Horizontal Position" />
                                    <input type="range" min="0" max="100" value={data?.alignY ?? 50} onChange={(e) => updateData(id, { alignY: parseInt(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" title="Vertical Position" />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {isGenerator && (
                     <div className="border-t border-zinc-700 pt-3 mt-2 space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-xs text-gray-400 font-bold">Noise Type</label>
                            <CustomSelect value={data?.noiseType || 'perlin'} onChange={(val) => updateData(id, { noiseType: val })} className="w-32" buttonClassName="bg-zinc-900 border-zinc-700 p-1 px-2 text-xs" options={[
                                { value: "perlin", label: "Perlin (Soft)" },
                                { value: "fbm", label: "Clouds (FBM)" },
                                { value: "ridge", label: "Electricity (Ridge)" },
                                { value: "worley", label: "Bubbles (Voronoi)" },
                                { value: "cells", label: "Cells (Voronoi ID)" }
                            ]} />
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-500 block mb-1">Scale: {data?.scale || 5}</label>
                            <input type="range" min="1" max="100" step="0.5" value={data?.scale ?? 5} onChange={(e) => updateData(id, { scale: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-500 block mb-1">{data?.noiseType === 'fbm' ? 'Octaves' : 'Detail'}: {data?.detail || 4}</label>
                            <input type="range" min="1" max={data?.noiseType === 'fbm' ? 8 : 10} step={data?.noiseType === 'fbm' ? 1 : 0.5} value={data?.detail ?? 4} onChange={(e) => updateData(id, { detail: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-500 block mb-1">Distortion: {data?.distortion || 0}</label>
                            <input type="range" min="0" max="5" step="0.1" value={data?.distortion ?? 0} onChange={(e) => updateData(id, { distortion: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                        </div>
                        <div className="pt-2 border-t border-zinc-700/50">
                            <div className="flex items-center justify-between">
                                <label className="text-xs text-gray-400 font-bold">Animate</label>
                                <input type="checkbox" checked={data?.isAnimating ?? false} onChange={(e) => updateData(id, { isAnimating: e.target.checked })} className="form-checkbox h-4 w-4 text-blue-600 bg-zinc-800 border-zinc-600 rounded focus:ring-blue-500" />
                            </div>
                            {data?.isAnimating ? (
                                <>
                                    <label className="text-[10px] text-gray-500 block mb-1 mt-2">Animation Speed: {data?.animSpeed || 0.1}</label>
                                    <input type="range" min="0" max="1" step="0.01" value={data?.animSpeed ?? 0.1} onChange={(e) => updateData(id, { animSpeed: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                                </>
                            ) : (
                                <>
                                    <label className="text-[10px] text-gray-500 block mb-1 mt-2">Time</label>
                                    <input type="range" min="0" max="100" step="0.1" value={data?.time ?? 0} onChange={(e) => updateData(id, { time: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-600 rounded appearance-none cursor-pointer" />
                                </>
                            )}
                        </div>
                    </div>
                )}

            </div>
            
            {!isOutput && <HandleCircle type="output" title="Output" top={50} active={isConnecting && activeConnectionId === id} onClick={(e) => { e.stopPropagation(); onHandleClick(id, 'output'); }} />}
            {isOutput && <HandleCircle type="input" title="Input" top={50} onClick={(e) => { e.stopPropagation(); onHandleClick(id, 'input'); }} />}
            
            {isMix && (
                <>
                    <HandleCircle type="base" title="Base Layer" top={50} onClick={(e) => { e.stopPropagation(); onHandleClick(id, 'base'); }} />
                    <HandleCircle type="blend" title="Blend Layer" top={90} onClick={(e) => { e.stopPropagation(); onHandleClick(id, 'blend'); }} />
                    <span className="absolute -left-12 top-[54px] text-[10px] text-gray-400 pointer-events-none w-8 text-right font-bold">Base</span>
                    <span className="absolute -left-12 top-[94px] text-[10px] text-gray-400 pointer-events-none w-8 text-right font-bold">Blend</span>
                </>
            )}
        </div>
    );
};

const NodeEditor = ({ activeSelection, currentCue, updateCueData, walls, setWalls, onOpenAssetBrowser }) => {
    const [nodes, setNodes] = useState([]);
    const [connections, setConnections] = useState([]);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [draggingId, setDraggingId] = useState(null);
    const dragOffset = useRef({ x: 0, y: 0 });
    const [connectSource, setConnectSource] = useState(null); 
    const [contextMenu, setContextMenu] = useState(null);
    const [hoveredConnectionIndex, setHoveredConnectionIndex] = useState(null);

    useEffect(() => {
        if(currentCue) {
            if(activeSelection.type === 'transition') {
                setNodes([ { id: 'n1', type: 'state', x: 50, y: 100, label: 'Prev Cue' }, { id: 'n2', type: 'effect', x: 300, y: 100, label: 'Crossfade' }, { id: 'n3', type: 'state', x: 600, y: 100, label: 'Next Cue' } ]);
                setConnections([{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
            } else {
                if(currentCue.nodes && currentCue.nodes.length > 0) {
                    setNodes(currentCue.nodes);
                    setConnections(currentCue.connections);
                    const existingWallIds = new Set(currentCue.nodes.filter(n => n.type === 'output').map(n => n.data.wallId));
                    const missingWalls = walls.filter(w => !existingWallIds.has(w.id));
                    if(missingWalls.length > 0) {
                        const newNodes = missingWalls.map((w, i) => ({ id: `wall-${w.id}`, type: 'output', x: 800, y: 50 + ((currentCue.nodes.length + i) * 150), label: w.name, data: { wallId: w.id } }));
                        setNodes(prev => [...prev, ...newNodes]);
                    }
                } else {
                    const newNodes = walls.map((w, i) => ({ id: `wall-${w.id}`, type: 'output', x: 800, y: 50 + (i * 200), label: w.name, data: { wallId: w.id } }));
                    setNodes(newNodes);
                    setConnections([]);
                }
            }
        }
    }, [activeSelection.cueId, activeSelection.type, walls.length]); 

    useEffect(() => {
        if(activeSelection.type === 'cue' && nodes.length > 0) {
            updateCueData({ nodes, connections });
        }
    }, [nodes, connections]);

    const handleDragStart = (e, id) => {
        e.stopPropagation();
        const node = nodes.find(n => n.id === id);
        dragOffset.current = { x: e.clientX - node.x * zoom - pan.x, y: e.clientY - node.y * zoom - pan.y };
        setDraggingId(id);
        setConnectSource(null); 
    };

    const handleHandleClick = (id, handleType) => {
        if(handleType === 'output') {
            if(connectSource?.id === id && connectSource?.handle === 'output') {
                setConnectSource(null); 
            } else {
                setConnectSource({ id, handle: 'output' });
            }
        } else {
            if(connectSource && connectSource.handle === 'output') {
                if(connectSource.id !== id) {
                    const filtered = connections.filter(c => !(c.to === id && c.toHandle === handleType));
                    setConnections([...filtered, { from: connectSource.id, to: id, toHandle: handleType }]);
                    setConnectSource(null);
                }
            }
        }
    };

    const handleMouseMove = (e) => {
        if (draggingId) {
            const newX = (e.clientX - pan.x - dragOffset.current.x) / zoom;
            const newY = (e.clientY - pan.y - dragOffset.current.y) / zoom;
            setNodes(prev => prev.map(n => n.id === draggingId ? { ...n, x: newX, y: newY } : n));
        } else if (e.buttons === 4 || (e.buttons === 1 && e.shiftKey)) {
            setPan(p => ({ x: p.x + e.movementX, y: p.y + e.movementY }));
        }
    };

    const handleMouseUp = () => setDraggingId(null);
    const handleBgClick = () => { setConnectSource(null); setContextMenu(null); };
    
    const handleWheel = (e) => {
        if (e.ctrlKey) {
            setZoom(z => Math.min(Math.max(z - e.deltaY * 0.001, 0.5), 2));
        } else {
            setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
        }
    };

    const handleContextMenu = (e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); };
    
    const addNode = (type, label) => { 
        const id = `n-${Date.now()}`; 
        const centerX = (window.innerWidth / 2 - pan.x) / zoom - 300; 
        const centerY = (200 - pan.y) / zoom; 
        setNodes(prev => [...prev, { id, type, x: centerX, y: centerY, label, data: type === 'color' ? { value: '#ffffff' } : type === 'noise' ? { noiseType: 'fbm', scale: 5, detail: 4, time: 0, distortion: 0, isAnimating: false, animSpeed: 0.05 } : {} }]); 
        setContextMenu(null); 
    };
    
    const handleAddImageNode = () => { addNode('image', 'Image Source'); };
    const updateNodeData = (id, data) => { setNodes(prev => prev.map(n => n.id === id ? { ...n, data: { ...n.data, ...data } } : n)); };
    const deleteConnection = (index) => { setConnections(prev => prev.filter((_, i) => i !== index)); };
    
    const deleteNode = (idToDelete) => {
        const nodeToDelete = nodes.find(n => n.id === idToDelete);
        if (!nodeToDelete) return;

        if (nodeToDelete.type === 'output') {
            alert("Cannot delete an output node. To remove a wall, delete it from the Geometry panel.");
            return;
        }

        setNodes(prev => prev.filter(n => n.id !== idToDelete));
        setConnections(prev => prev.filter(c => c.from !== idToDelete && c.to !== idToDelete));
    };

    const getHandleOffset = (node, handle) => {
        if (!node) return { x: 0, y: 0 };
        const width = 256; 
        if (handle === 'output') return { x: node.x + width + 8, y: node.y + 64 };
        if (node.type === 'output') return { x: node.x - 8, y: node.y + 64 };
        if (handle === 'base') return { x: node.x - 8, y: node.y + 64 };
        if (handle === 'blend') return { x: node.x - 8, y: node.y + 104 };
        return { x: node.x - 8, y: node.y + 64 };
    };

    const getBezierMidpoint = (p0, p1, p2, p3) => {
         const t = 0.5;
         const x = (1-t)*(1-t)*(1-t)*p0.x + 3*(1-t)*(1-t)*t*p1.x + 3*(1-t)*t*t*p2.x + t*t*t*p3.x;
         const y = (1-t)*(1-t)*(1-t)*p0.y + 3*(1-t)*(1-t)*t*p1.y + 3*(1-t)*t*t*p2.y + t*t*t*p3.y;
         return {x, y};
    };

    return (
        <div className="h-full bg-transparent relative overflow-hidden select-none" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel} onContextMenu={handleContextMenu} onClick={handleBgClick}>
            <div className="absolute inset-0 node-grid opacity-30" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}></div>
            <div className="absolute top-2 left-2 z-10 flex gap-2 pointer-events-none">
                <div className="bg-zinc-800/80 backdrop-blur border border-zinc-700 rounded p-2 flex items-center gap-2 shadow-lg pointer-events-auto">
                    <Workflow size={14} className="text-purple-400" />
                    <span className="text-xs font-bold text-gray-300">{activeSelection.type === 'transition' ? 'Transition Logic' : 'Content Graph'}</span>
                    {activeSelection.type === 'cue' && (
                        <>
                            <div className="w-px h-4 bg-zinc-600 mx-1"></div>
                            <button onClick={handleAddImageNode} className="flex items-center gap-1 bg-purple-700 hover:bg-purple-600 text-white text-[10px] px-2 py-1 rounded transition-colors"> <Plus size={10}/> Add Image </button>
                            <button onClick={() => addNode('video', 'Video')} className="flex items-center gap-1 bg-pink-700 hover:bg-pink-600 text-white text-[10px] px-2 py-1 rounded transition-colors"> <Video size={10}/> Add Video </button>
                            <button onClick={() => addNode('color', 'Color')} className="flex items-center gap-1 bg-sky-700 hover:bg-sky-600 text-white text-[10px] px-2 py-1 rounded transition-colors"> <Palette size={10}/> Add Color </button>
                            <button onClick={() => addNode('mix', 'Mixer')} className="flex items-center gap-1 bg-orange-700 hover:bg-orange-600 text-white text-[10px] px-2 py-1 rounded transition-colors"> <Blend size={10}/> Add Mix </button>
                            <button onClick={() => addNode('noise', 'Noise')} className="flex items-center gap-1 bg-teal-700 hover:bg-teal-600 text-white text-[10px] px-2 py-1 rounded transition-colors"> <Activity size={10}/> Add Noise </button>
                        </>
                    )}
                </div>
            </div>
            {contextMenu && activeSelection.type === 'cue' && (
                <div className="absolute z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 w-32" style={{top: contextMenu.y - 40, left: contextMenu.x}}>
                    <div className="px-2 py-1 text-[10px] text-gray-500 font-bold uppercase">Add Node</div>
                    <button onClick={() => addNode('image', 'Image Source')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-purple-600 flex gap-2"><ImageIcon size={12}/> Image</button>
                    <button onClick={() => addNode('video', 'Video Source')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-purple-600 flex gap-2"><Video size={12}/> Video</button>
                    <button onClick={() => addNode('color', 'Color Source')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-purple-600 flex gap-2"><Palette size={12}/> Color</button>
                    <button onClick={() => addNode('noise', 'Noise Generator')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-purple-600 flex gap-2"><Activity size={12}/> Noise</button>
                    <div className="w-full h-px bg-zinc-700 my-1"></div>
                    <button onClick={() => addNode('mix', 'Mix / Mask')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-orange-600 flex gap-2"><Blend size={12}/> Mixer</button>
                </div>
            )}
            <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', width: '100%', height: '100%' }}>
                <svg className="absolute inset-0 overflow-visible pointer-events-auto">
                    {connections.map((conn, i) => {
                        const fromNode = nodes.find(n => n.id === conn.from);
                        const toNode = nodes.find(n => n.id === conn.to);
                        if(!fromNode || !toNode) return null;
                        
                        const start = getHandleOffset(fromNode, 'output');
                        const end = getHandleOffset(toNode, conn.toHandle || 'input'); 

                        const cp1x = start.x + (end.x - start.x) / 2; 
                        const cp2x = end.x - (end.x - start.x) / 2;
                        
                        const isHovered = hoveredConnectionIndex === i;
                        const mid = getBezierMidpoint({x:start.x, y:start.y}, {x:cp1x, y:start.y}, {x:cp2x, y:end.y}, {x:end.x, y:end.y});

                        return (
                            <g key={i} onMouseEnter={() => setHoveredConnectionIndex(i)} onMouseLeave={() => setHoveredConnectionIndex(null)}>
                                <path d={`M ${start.x} ${start.y} C ${cp1x} ${start.y}, ${cp2x} ${end.y}, ${end.x} ${end.y}`} fill="none" stroke="transparent" strokeWidth="20" />
                                <path d={`M ${start.x} ${start.y} C ${cp1x} ${start.y}, ${cp2x} ${end.y}, ${end.x} ${end.y}`} fill="none" stroke={isHovered ? "#ef4444" : "#555"} strokeWidth="2" />
                                {isHovered && (
                                    <foreignObject x={mid.x - 12} y={mid.y - 12} width="24" height="24" className="overflow-visible">
                                        <div 
                                            className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center cursor-pointer hover:scale-125 transition-transform shadow-lg"
                                            onClick={(e) => { e.stopPropagation(); deleteConnection(i); }}
                                            title="Remove Connection"
                                        >
                                            <Trash2 size={12} className="text-white"/>
                                        </div>
                                    </foreignObject>
                                )}
                            </g>
                        );
                    })}
                </svg>
                {nodes.map(node => ( <div key={node.id}><Node id={node.id} {...node} selected={draggingId === node.id} isConnecting={!!connectSource} activeConnectionId={connectSource?.id} onDragStart={handleDragStart} onHandleClick={handleHandleClick} updateData={updateNodeData} onDelete={deleteNode} onOpenAssetBrowser={onOpenAssetBrowser} /></div>))}
            </div>
        </div>
    );
};

// --- TRANSITION EDITOR ---

const getEase = (t, type) => {
    if (t < 0) return 0;
    if (t > 1) return 1;
    switch (type) {
        case 'easeIn': return t * t;
        case 'easeOut': return t * (2 - t);
        case 'easeInOut': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        default: return t;
    }
};

const TransitionEditor = ({ cue, updateCue }) => {
    if (!cue) return <div className="h-full flex items-center justify-center text-gray-500 text-xs">Select a transition to edit</div>;

    const duration = cue.transitionDuration ?? 1.0;
    const delay = cue.transitionDelay ?? 0.0;
    const ease = cue.transitionEase || 'linear';

    const { points, totalTime } = useMemo(() => {
        const width = 600; const height = 200; const padding = 40;
        const graphW = width - padding * 2; const graphH = height - padding * 2;
        const totalTime = Math.max(duration + delay + 1, 5);
        const steps = 100;
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * totalTime;
            let val = 0;
            if (t >= delay) { 
                const localT = duration > 0 ? Math.min((t - delay) / duration, 1) : 1; 
                val = getEase(localT, ease); 
            }
            const x = padding + (t / totalTime) * graphW; 
            const y = height - padding - (val * graphH);
            pts.push(`${x},${y}`);
        }
        return { points: pts, totalTime };
    }, [duration, delay, ease]);

    const width = 600; const height = 200; const padding = 40;
    const graphW = width - padding * 2;

    return (
        <div className="w-full h-full bg-transparent p-6 flex gap-8 text-gray-300">
            <div className="w-64 flex flex-col gap-6 pt-2">
                <div><h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Link size={16}/> TRANSITION SETTINGS</h3>
                    <div className="space-y-4">
                        <div><div className="flex justify-between mb-1"><label className="text-xs font-bold">Duration</label><span className="text-xs font-mono text-blue-400">{duration.toFixed(1)}s</span></div>
                        <input type="range" min="0" max="10" step="0.1" value={duration} onInput={(e) => updateCue({ transitionDuration: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500" /></div>
                        <div><div className="flex justify-between mb-1"><label className="text-xs font-bold">Delay</label><span className="text-xs font-mono text-orange-400">{delay.toFixed(1)}s</span></div>
                        <input type="range" min="0" max="5" step="0.1" value={delay} onInput={(e) => updateCue({ transitionDelay: parseFloat(e.target.value) })} className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500" /></div>
                        <div><label className="text-xs font-bold block mb-2">Easing Curve</label><div className="grid grid-cols-2 gap-2">{['linear', 'easeIn', 'easeOut', 'easeInOut'].map(e => (<button key={e} onClick={() => updateCue({ transitionEase: e })} className={`px-3 py-2 rounded text-xs font-medium border transition-all ${ease === e ? 'bg-blue-600 border-blue-500 text-white' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}>{e.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</button>))}</div></div>
                    </div>
                </div>
            </div>
            <div className="flex-1 bg-zinc-950 rounded-xl border border-zinc-800 relative shadow-inner overflow-hidden">
                <div className="absolute top-3 left-4 text-[10px] font-mono text-zinc-500">OPACITY / TIME</div>
                <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="absolute inset-0">
                    <line x1={padding} y1={height-padding} x2={width-padding} y2={height-padding} stroke="#333" strokeWidth="1" />
                    <line x1={padding} y1={padding} x2={padding} y2={height-padding} stroke="#333" strokeWidth="1" />
                    <path d={`M ${points.join(' L ')}`} fill="none" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" />
                    <path d={`M ${points[0]} L ${points.join(' L ')} L ${points[points.length-1].split(',')[0]},${height-padding} Z`} fill="url(#gradient)" opacity="0.2" />
                    <defs><linearGradient id="gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#60a5fa" /><stop offset="100%" stopColor="transparent" /></linearGradient></defs>
                    <line x1={padding + (delay / totalTime) * graphW} y1={padding} x2={padding + (delay / totalTime) * graphW} y2={height-padding} stroke="#fb923c" strokeWidth="1" strokeDasharray="4,4" />
                    <line x1={padding + ((delay + duration) / totalTime) * graphW} y1={padding} x2={padding + ((delay + duration) / totalTime) * graphW} y2={height-padding} stroke="#fb923c" strokeWidth="1" strokeDasharray="4,4" />
                </svg>
            </div>
        </div>
    );
};

// --- MAIN APP ---

const WallStackVisualizer = ({ walls, activeWallId }) => {
    if (walls.length === 0) return null;

    return (
        <div className="mt-4 pt-4 border-t border-zinc-700">
            <h3 className="text-xs font-bold text-gray-500 mb-3 flex items-center gap-1"><Layers size={12}/> STACKING ORDER</h3>
            <div className="relative h-24 bg-zinc-800/50 rounded-lg p-4 flex items-center justify-start overflow-x-auto">
                {walls.slice().reverse().map((wall, index) => (
                    <div
                        key={wall.id}
                        title={`${wall.name}`}
                        className={`absolute w-12 h-12 rounded border-2 transition-all duration-300 ease-out flex items-center justify-center text-white font-bold text-xs shadow-md ${wall.id === activeWallId ? 'border-blue-400 ring-2 ring-blue-500/50' : 'border-zinc-600 hover:border-zinc-400'}`}
                        style={{
                            backgroundColor: wall.color,
                            left: `${10 + index * 15}%`,
                            zIndex: walls.length - index,
                            transform: `translateY(${wall.id === activeWallId ? '-8px' : '0px'}) scale(${wall.id === activeWallId ? '1.1' : '1'})`
                        }}
                    >
                        {walls.length - index}
                    </div>
                ))}
            </div>
        </div>
    );
};

const WallItem = ({ wall, activeWallId, setActiveWallId, moveWall, deleteWall }) => {
    return (
        <div 
            onClick={() => setActiveWallId(wall.id)} 
            className={`flex justify-between items-center p-2 rounded text-xs cursor-pointer ${wall.id === activeWallId ? 'bg-zinc-700 text-white border border-zinc-600' : 'text-gray-400 hover:bg-zinc-800/50'}`}
        >
            <div className="flex items-center gap-2 truncate">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: wall.color }}></div>
                <span className="truncate">{wall.name}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
                <div className="flex flex-col -my-1">
                    <button onClick={(e) => {e.stopPropagation(); moveWall(wall.id, -1)}} className="p-0.5 rounded hover:bg-zinc-600 text-gray-400 hover:text-white"><ChevronUp size={16}/></button>
                    <button onClick={(e) => {e.stopPropagation(); moveWall(wall.id, 1)}} className="p-0.5 rounded hover:bg-zinc-600 text-gray-400 hover:text-white"><ChevronDown size={16}/></button>
                </div>
                <button onClick={(e) => {e.stopPropagation(); deleteWall(wall.id, wall.name)}} className="p-1 rounded hover:bg-red-900/50 text-gray-500 hover:text-red-400"><Trash2 size={14}/></button>
            </div>
        </div>
    );
};

const FolderItem = ({ folder, walls, activeWallId, setActiveWallId, setWalls, setFolders, moveWall, deleteWall, showConfirm }) => {
    const folderWalls = walls.filter(w => w.folderId === folder.id);
    return (
        <div className="mb-2">
            <div className="flex items-center gap-2 p-2 bg-zinc-800 hover:bg-zinc-700 rounded cursor-pointer text-xs font-bold text-gray-300" onClick={() => setFolders(prev => prev.map(f => f.id === folder.id ? {...f, isOpen: !f.isOpen} : f))}>
                {folder.isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} <Folder size={14} className="text-blue-400" /> {folder.name} <span className="ml-auto text-[10px] text-gray-500">{folderWalls.length}</span>
                <button 
                    onClick={(e) => {
                        e.stopPropagation();
                        showConfirm(
                            "Delete Group", 
                            `Are you sure you want to delete the group "${folder.name}"? The objects inside will not be deleted.`, 
                            () => {
                                setFolders(prev => prev.filter(f => f.id !== folder.id));
                                setWalls(prev => prev.map(w => w.folderId === folder.id ? {...w, folderId: null} : w));
                            }
                        );
                    }} 
                    className="text-gray-500 hover:text-red-400 ml-2"
                >
                    <Trash2 size={12}/>
                </button>
            </div>
            {folder.isOpen && (
                <div className="ml-2 pl-2 border-l border-zinc-700 mt-1 space-y-1">
                    {folderWalls.map(wall => (
                        <WallItem key={wall.id} wall={wall} activeWallId={activeWallId} setActiveWallId={setActiveWallId} moveWall={moveWall} deleteWall={deleteWall} />
                    ))}
                </div>
            )}
        </div>
    );
};

// --- MODAL COMPONENT ---

const Modal = ({ isOpen, title, message, onConfirm, onCancel, type = 'confirm' }) => {
    if (!isOpen) return null;
    return createPortal(
        <div className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-scale">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 w-96 flex flex-col gap-4">
                <div className="flex items-center gap-3 text-red-400">
                    <AlertTriangle size={24} />
                    <h3 className="text-lg font-bold text-white uppercase tracking-wider">{title}</h3>
                </div>
                <p className="text-sm text-gray-300 leading-relaxed">{message}</p>
                <div className="flex justify-end gap-3 mt-2">
                    {type === 'confirm' && (
                        <button onClick={onCancel} className="px-4 py-2 rounded text-xs font-bold text-gray-400 hover:text-white hover:bg-zinc-800 transition-colors">
                            CANCEL
                        </button>
                    )}
                    <button onClick={onConfirm} className="px-6 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-lg shadow-red-900/20 transition-all">
                        {type === 'confirm' ? 'PROCEED' : 'OK'}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

export default function App() {
    const [modal, setModal] = useState({ isOpen: false, title: '', message: '', onConfirm: null, type: 'confirm' });
    const showConfirm = (title, message, onConfirm) => setModal({ isOpen: true, title, message, onConfirm: () => { onConfirm(); setModal(prev => ({ ...prev, isOpen: false })); }, type: 'confirm' });
    const showAlert = (title, message) => setModal({ isOpen: true, title, message, onConfirm: () => setModal(prev => ({ ...prev, isOpen: false })), type: 'alert' });

    const [walls, setWalls] = useState([{ id: 1, name: "Main Wall", color: "#84cc16", folderId: null, points: [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 325 }, { x: 100, y: 325 }] }]);
    const [folders, setFolders] = useState([]); 
    const [activeWallId, setActiveWallId] = useState(1);
    const [menuOpen, setMenuOpen] = useState(true); // Open menu by default
    const [viewMode, setViewMode] = useState('2d'); 
    const [showGuides, setShowGuides] = useState(false); 
    const [moveMode, setMoveMode] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showNodeEditor, setShowNodeEditor] = useState(true);
    const [storageUsage, setStorageUsage] = useState(null);
    const [assetBrowserState, setAssetBrowserState] = useState({ isOpen: false, type: 'image', callback: null });
    const [showProjectManager, setShowProjectManager] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [activeProjectId, setActiveProjectId] = useState(null);
    const [usbDrives, setUsbDrives] = useState([]);
    
    // USB Polling
    useEffect(() => {
        const checkDrives = async () => {
            const drives = await db.getDrives();
            setUsbDrives(prev => {
                if (drives.length > prev.length) {
                    // New drive detected!
                    const newDrive = drives.find(d => !prev.some(pd => pd.path === d.path));
                    if (newDrive) {
                        console.log("USB Detected:", newDrive.name);
                        // Optional: show a small toast or notification
                    }
                }
                return drives;
            });
        };
        const interval = setInterval(checkDrives, 5000);
        checkDrives();
        return () => clearInterval(interval);
    }, []);
    
    const [menuTab, setMenuTab] = useState('config'); 
    const [scenes, setScenes] = useState([]); // Start empty
    const [activeSelection, setActiveSelection] = useState({ type: 'cue', sceneId: null, cueId: null });
    
    const [transitionMix, setTransitionMix] = useState(1);
    const [prevCueState, setPrevCueState] = useState(null);
    const [currentCueState, setCurrentCueState] = useState(null);
    const requestRef = useRef();
    const startTimeRef = useRef();
    const lastSaveRef = useRef(0);
    const saveTimeoutRef = useRef();

    const [lastDisplayState, setLastDisplayState] = useState(null);
    const prevMenuTabRef = useRef(menuTab);

    useEffect(() => {
        if (activeSelection) {
            db.saveState('active_cue_selection', activeSelection);
        }
    }, [activeSelection]);

    // Synchronize UI state to the projection screens
    useEffect(() => {
        if (isLoading) return; // DON'T SYNC WHILE LOADING
        console.log("[APP] Syncing UI state...");
        db.saveState('ui_sync_state', { viewMode, menuTab, showGuides, activeWallId });
    }, [viewMode, menuTab, showGuides, activeWallId, isLoading]);

    useEffect(() => {
        if (prevMenuTabRef.current !== 'scenes' && menuTab === 'scenes') {
            setLastDisplayState({ showGuides, moveMode });
            setShowGuides(false);
            setMoveMode(false);
        } else if (prevMenuTabRef.current === 'scenes' && menuTab !== 'scenes') {
            if (lastDisplayState) {
                setShowGuides(lastDisplayState.showGuides);
                setMoveMode(lastDisplayState.moveMode);
                setLastDisplayState(null);
            }
        }
        prevMenuTabRef.current = menuTab;
    }, [menuTab]);

    useEffect(() => {
        const loadData = async () => {
            setIsLoading(true);
            try {
                const activeProject = await db.getActiveProject();
                if (activeProject && activeProject.id) {
                    setActiveProjectId(activeProject.id);
                    const savedState = await db.loadState('project_data_v22');
                    if (savedState) {
                        setWalls(savedState.walls || []);
                        setFolders(savedState.folders || []);
                        setScenes(savedState.scenes || []);
                        if (savedState.scenes?.length > 0 && savedState.scenes[0].cues?.length > 0) {
                            setActiveSelection({ type: 'cue', sceneId: savedState.scenes[0].id, cueId: savedState.scenes[0].cues[0].id });
                        }
                    }
                    const usage = await db.getUsage();
                    setStorageUsage(usage);
                    setShowProjectManager(false);
                } else {
                    // No active project, force project manager
                    setActiveProjectId(null);
                    setShowProjectManager(true);
                }
            } catch (e) {
                console.error("Failed to load state", e);
                setShowProjectManager(true);
            } finally {
                // Keep loading screen up for a bit to ensure UI is ready
                setTimeout(() => setIsLoading(false), 800);
            }
        };
        loadData();
    }, []);

    useEffect(() => {
        if (isLoading || !activeProjectId) return; // DON'T SAVE WHILE LOADING OR WITHOUT PROJECT

        const now = Date.now();
        const throttleMs = 50; 

        const doSave = async () => {
            console.log("[APP] Executing save to database for project:", activeProjectId);
            lastSaveRef.current = Date.now();
            await db.saveState('project_data_v22', { walls, folders, scenes });
        };

        if (now - lastSaveRef.current > throttleMs) {
            console.log("[APP] Throttled save triggered");
            doSave();
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        } else {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(() => {
                console.log("[APP] Debounced save triggered");
                doSave();
            }, 500); // Wait 500ms for the final save to be safe
        }

        return () => {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        };
    }, [walls, folders, scenes, isLoading, activeProjectId]);

    useEffect(() => {
        const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handleFsChange);
        return () => document.removeEventListener('fullscreenchange', handleFsChange);
    }, []);

    const enterFullscreen = () => { 
        setIsFullscreen(true); // Manually set so the app starts immediately
        document.documentElement.requestFullscreen().catch(e => console.log("Fullscreen request failed:", e)); 
    };
    const getCueData = (sId, cId) => { const s = scenes.find(x => x.id === sId); return s ? s.cues.find(x => x.id === cId) : null; };
    const targetCueId = activeSelection.type === 'cue' ? activeSelection.cueId : activeSelection.nextCueId;
    const currentCueObj = useMemo(() => getCueData(activeSelection.sceneId, targetCueId), [activeSelection, scenes]);
    const currentCueObjRef = useRef(currentCueObj);
    useEffect(() => { currentCueObjRef.current = currentCueObj; }, [currentCueObj]);

    const currentSceneIndex = useMemo(() => scenes.findIndex(s => s.id === activeSelection.sceneId), [scenes, activeSelection.sceneId]);
    const currentCueIndex = useMemo(() => {
        const scene = scenes[currentSceneIndex];
        if (!scene) return -1;
        return scene.cues.findIndex(c => c.id === targetCueId);
    }, [currentSceneIndex, scenes, targetCueId]);

    const updateCueData = (newData) => {
        setScenes(prev => prev.map(s => {
            if(s.id !== activeSelection.sceneId) return s;
            return { ...s, cues: s.cues.map(c => { if(c.id !== targetCueId) return c; return { ...c, ...newData }; }) }
        }));
    };

    const animateTransition = (time) => {
        if (!startTimeRef.current) startTimeRef.current = time;
        const cue = currentCueObjRef.current;
        const duration = (cue?.transitionDuration || 0) * 1000;
        const delay = (cue?.transitionDelay || 0) * 1000;
        const totalDuration = duration + delay;
        
        const elapsed = time - startTimeRef.current;
        
        let mix = 1;
        if (totalDuration > 0) {
            if (elapsed < delay) mix = 0;
            else mix = duration > 0 ? Math.min((elapsed - delay) / duration, 1) : 1;
        }
        
        const ease = cue?.transitionEase || 'linear';
        setTransitionMix(getEase(mix, ease));

        if (elapsed < totalDuration) { requestRef.current = requestAnimationFrame(animateTransition); }
        else { setTransitionMix(1); setPrevCueState(null); }
    };

    useEffect(() => {
        if (currentCueObj) {
            let startState = (currentCueState || prevCueState);
            if (activeSelection.type === 'transition' && activeSelection.prevCueId) {
                 const prevCue = scenes.find(s => s.id === activeSelection.sceneId)?.cues.find(c => c.id === activeSelection.prevCueId);
                 if (prevCue) startState = prevCue;
            } else if (prevCueState && transitionMix < 1) {
                startState = { 
                    ...currentCueState, 
                    nodes: currentCueState.nodes.map(n => {
                        const prev = prevCueState.nodes?.find(pn => pn.id === n.id);
                        return prev ? getInterpolatedNode(prev, n, transitionMix) : n;
                    })
                };
            }

            setPrevCueState(startState);
            setCurrentCueState(currentCueObj);
            setTransitionMix(0); 
            startTimeRef.current = null;
            cancelAnimationFrame(requestRef.current);
            requestRef.current = requestAnimationFrame(animateTransition);
        }
        return () => cancelAnimationFrame(requestRef.current);
    }, [targetCueId, activeSelection.sceneId, activeSelection.type, activeSelection.prevCueId]); 

    useEffect(() => { if (activeSelection.type === 'cue') setCurrentCueState(currentCueObj); }, [scenes]); 

    const navigateCue = (direction) => {
        let flatList = [];
        scenes.forEach(s => { s.cues.forEach(c => { flatList.push({ sceneId: s.id, cueId: c.id }); }); });
        const currentIndex = flatList.findIndex(i => i.sceneId === activeSelection.sceneId && i.cueId === targetCueId);
        if (currentIndex === -1) return;
        let nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < flatList.length) { setActiveSelection({ type: 'cue', ...flatList[nextIndex] }); }
    };

    useEffect(() => {
        const handleKeyDown = (e) => { 
            const k = e.key.toLowerCase();
            // Prevent browser shortcuts
            if (e.ctrlKey && (k === 'r' || k === 'f' || k === 'p' || k === 's')) e.preventDefault();
            if (k === 'f5' || k === 'f11' || k === 'f12') e.preventDefault();

            if (k === 'h') { if (viewMode === 'live') { setViewMode('2d'); setMenuOpen(true); } else { setMenuOpen(p => !p); } }
            if (k === 'g' && viewMode !== 'live') setShowGuides(p => !p); 
            if (k === 'm' && viewMode === '2d') setMoveMode(p => !p);
            if ((viewMode === 'live' || menuTab === 'scenes') && (k === 'z' || k === 'v' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                navigateCue((k === 'z' || e.key === 'ArrowRight') ? 1 : -1);
            }
        };
        const handleContextMenu = (e) => e.preventDefault();
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('contextmenu', handleContextMenu);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('contextmenu', handleContextMenu);
        };
    }, [viewMode, menuTab, activeSelection, scenes]);

    const moveScene = (index, direction) => {
        setScenes(prev => {
            const newScenes = [...prev];
            if (index + direction < 0 || index + direction >= newScenes.length) return prev;
            [newScenes[index], newScenes[index + direction]] = [newScenes[index + direction], newScenes[index]];
            return newScenes;
        });
    };

    const deleteScene = (id) => { 
        showConfirm("Delete Act", "Are you sure you want to delete this Act and all its cues?", () => {
            setScenes(p => {
                const updated = p.filter(s => s.id !== id);
                // If active scene was deleted, select first available cue in first available scene
                if (activeSelection.sceneId === id) {
                    if (updated.length > 0 && updated[0].cues?.length > 0) {
                        setActiveSelection({ type: 'cue', sceneId: updated[0].id, cueId: updated[0].cues[0].id });
                    } else {
                        setActiveSelection({ type: 'cue', sceneId: null, cueId: null });
                    }
                }
                return updated;
            }); 
        });
    };
    const deleteCue = (sId, cId) => { 
        showConfirm("Delete Cue", "Are you sure you want to delete this cue?", () => {
            setScenes(p => p.map(s => {
                if (s.id !== sId) return s;
                const updatedCues = s.cues.filter(c => c.id !== cId);
                // If active cue was deleted
                if (activeSelection.sceneId === sId && activeSelection.cueId === cId) {
                    if (updatedCues.length > 0) {
                        setActiveSelection({ type: 'cue', sceneId: sId, cueId: updatedCues[0].id });
                    } else {
                        // Look for another scene
                        const otherScene = scenes.find(osc => osc.id !== sId && osc.cues?.length > 0);
                        if (otherScene) {
                            setActiveSelection({ type: 'cue', sceneId: otherScene.id, cueId: otherScene.cues[0].id });
                        } else {
                            setActiveSelection({ type: 'cue', sceneId: null, cueId: null });
                        }
                    }
                }
                return {...s, cues: updatedCues};
            })); 
        });
    };
    const addScene = () => { 
        const id = Date.now(); 
        const name = `Act ${scenes.length + 1}`;
        const newScene = {id, name, cues: [{id: id + 1, name: "Cue 1", type: 'standard'}]};
        setScenes(p => [...p, newScene]); 
        if (scenes.length === 0) {
            setActiveSelection({ type: 'cue', sceneId: id, cueId: id + 1 });
        }
    };
    const addCue = (sId) => { 
        setScenes(p => p.map(s => {
            if (s.id !== sId) return s;
            const id = Date.now();
            const name = `Cue ${s.cues.length + 1}`;
            const updated = {...s, cues: [...s.cues, {id, name, type: 'standard'}]};
            if (activeSelection.cueId === null) {
                setActiveSelection({ type: 'cue', sceneId: sId, cueId: id });
            }
            return updated;
        })); 
    };

    const updatePoint = (wallId, idx, cx, cy) => { setWalls(p => p.map(w => { if(w.id !== wallId) return w; const pts = [...w.points]; if(moveMode) { const dx = cx - pts[idx].x; const dy = cy - pts[idx].y; return {...w, points: pts.map(pt => ({x: pt.x + dx, y: pt.y + dy}))}; } pts[idx] = {x:cx, y:cy}; return {...w, points: pts}; })); };
    const addFolder = () => setFolders(p => [...p, {id: Date.now(), name: "Group", isOpen: true}]);
    const deleteWall = (id, name) => {
        showConfirm("Delete Wall", `Are you sure you want to delete the wall "${name}"?`, () => {
            if (activeWallId === id) setActiveWallId(null);
            setWalls(p => p.filter(w => w.id !== id));
            setScenes(prev => prev.map(scene => ({
                ...scene,
                cues: scene.cues.map(cue => {
                    if (!cue.nodes) return cue;
                    const nodesKeep = cue.nodes.filter(n => !(n.type === 'output' && n.data.wallId === id));
                    const nodeIdsKeep = new Set(nodesKeep.map(n => n.id));
                    const connectionsKeep = (cue.connections || []).filter(c => nodeIdsKeep.has(c.from) && nodeIdsKeep.has(c.to));
                    return { ...cue, nodes: nodesKeep, connections: connectionsKeep };
                })
            })));
        });
    };
    const moveWall = (id, dir) => { setWalls(p => { const idx = p.findIndex(w => w.id === id); if(idx === -1 || idx+dir < 0 || idx+dir >= p.length) return p; const res = [...p]; [res[idx], res[idx+dir]] = [res[idx+dir], res[idx]]; return res; }); };

    const activeWall = walls.find(w => w.id === activeWallId);

    const renderSVG = (isLive) => (
        <svg className="w-full h-full" style={{backgroundColor: (isLive || menuTab === 'scenes') ? 'black' : 'transparent'}}>
            <defs>
                 <pattern id="smallGrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5"/></pattern>
                 <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#smallGrid)"/><path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1"/></pattern>
            </defs>
            {showGuides && !isLive && menuTab !== 'scenes' && (<><rect width="100%" height="100%" fill="url(#grid)" pointerEvents="none" /><line x1="50%" y1="0" x2="50%" y2="100%" stroke="cyan" strokeOpacity="0.5" strokeDasharray="5,5" pointerEvents="none" /><line x1="0" y1="50%" x2="100%" y2="50%" stroke="cyan" strokeOpacity="0.5" strokeDasharray="5,5" pointerEvents="none" /></>)}
            {walls.map(wall => {
                const getWallStyle = (cueState) => {
                    return { fill: wall.color, stroke: isLive ? 'none' : wall.color };
                };
                const currStyle = getWallStyle(currentCueState);
                const baseOpacity = isLive ? 1 : (wall.id === activeWallId ? 0.5 : 0.1);
                
                const isProjecting = (isLive || menuTab === 'scenes') && currentCueState?.nodes?.some(n => n.type === 'output' && n.data.wallId === wall.id && currentCueState.connections?.some(c => c.to === n.id));
                
                return (
                    <g key={wall.id} onClick={(e) => { if(!isLive) { e.stopPropagation(); setActiveWallId(wall.id); }}}>
                        {isProjecting && ( <path d={`M ${wall.points[0].x} ${wall.points[0].y} L ${wall.points[1].x} ${wall.points[1].y} L ${wall.points[2].x} ${wall.points[2].y} L ${wall.points[3].x} ${wall.points[3].y} Z`} fill="transparent" stroke="none" /> )}
                        {!isProjecting && (isLive || menuTab === 'scenes') && ( <path d={`M ${wall.points[0].x} ${wall.points[0].y} L ${wall.points[1].x} ${wall.points[1].y} L ${wall.points[2].x} ${wall.points[2].y} L ${wall.points[3].x} ${wall.points[3].y} Z`} fill={currStyle.fill} fillOpacity={baseOpacity} stroke="none" /> )}
                        {(!isLive && menuTab !== 'scenes') && ( <path d={`M ${wall.points[0].x} ${wall.points[0].y} L ${wall.points[1].x} ${wall.points[1].y} L ${wall.points[2].x} ${wall.points[2].y} L ${wall.points[3].x} ${wall.points[3].y} Z`} fill={currStyle.fill} fillOpacity={baseOpacity} stroke={currStyle.stroke} strokeWidth={wall.id === activeWallId ? 2 : 1} strokeDasharray="5,5" /> )}
                        {(isLive && currentCueObj?.type === 'test') && <WarpedTextureGrid wallPoints={wall.points} />}
                        {(!isLive && (wall.id === activeWallId) && menuTab !== 'scenes') && wall.points.map((p, i) => ( <PointHandle key={`handle-${wall.id}-${i}`} index={i} x={p.x} y={p.y} color={wall.color} isSelected={true} onDrag={(idx, x, y) => updatePoint(wall.id, idx, x, y)} isMoveMode={moveMode} /> ))}
                        {showGuides && !isLive && menuTab !== 'scenes' && wall.points.map((p, i) => ( <text key={`guide-lbl-${i}`} x={p.x + 12} y={p.y + 4} fill="lime" fontSize="9" fontFamily="monospace" className="pointer-events-none select-none shadow-black drop-shadow-md" style={{textShadow: '1px 1px 0 #000'}}> {Math.round(p.x)},{Math.round(p.y)} </text> ))}
                        {showGuides && !isLive && menuTab !== 'scenes' && ( <g pointerEvents="none"> <line x1={wall.points[0].x} y1={wall.points[0].y} x2={wall.points[2].x} y2={wall.points[2].y} stroke="cyan" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="4,4" /> <line x1={wall.points[1].x} y1={wall.points[1].y} x2={wall.points[3].x} y2={wall.points[3].y} stroke="cyan" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="4,4" /> </g> )}
                    </g>
                );
            })}
            {(!isLive && activeWall && menuTab !== 'scenes') && activeWall.points.map((p, i) => ( <PointHandle key={`handle-${activeWall.id}-${i}`} index={i} x={p.x} y={p.y} color={activeWall.color} isSelected={true} onDrag={(idx, x, y) => updatePoint(activeWall.id, idx, x, y)} isMoveMode={moveMode} /> ))}
        </svg>
    );

    return (
        <div className="w-full h-full relative font-sans text-white bg-zinc-950 flex flex-col">
            {isLoading && <LoadingScreen />}

            {!isFullscreen && (
                <div className="absolute inset-0 z-[100] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center text-center p-8">
                    <div className="max-w-4xl space-y-8">
                        <img src="/robotic T M.png" className="w-[600px] mx-auto mb-8" alt="Logo" />
                        <h1 className="text-5xl font-bold text-white mb-4">Emap</h1>
                        <button onClick={enterFullscreen} className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-xl font-bold text-2xl flex items-center gap-3 mx-auto">
                            <Maximize size={28} /> Start
                        </button>
                    </div>
                </div>
            )}

                                <ProjectManager isOpen={showProjectManager} onClose={() => setShowProjectManager(false)} activeProjectId={activeProjectId} showConfirm={showConfirm} showAlert={showAlert} setIsLoading={setIsLoading} />
                                <AssetBrowser isOpen={assetBrowserState.isOpen} onClose={() => setAssetBrowserState({isOpen:false})} onSelect={(a) => {assetBrowserState.callback(a); setAssetBrowserState({isOpen:false})}} initialTab={assetBrowserState.type} showConfirm={showConfirm} showAlert={showAlert} />
            <div className={`absolute inset-0 h-full z-0 ${!activeProjectId ? 'hidden' : ''}`}>
                <div className="absolute inset-0 z-10" onClick={() => setActiveWallId(null)}>
                    <WallBackgroundLayer walls={walls} currentCueState={currentCueState} isLive={viewMode === 'live'} isTransitioning={transitionMix < 1} shouldShow={menuTab === 'scenes'} />
                    {(viewMode === 'live' || menuTab === 'scenes') && <TransitioningProjectedContent prevCueState={prevCueState} currentCueState={currentCueState} mix={transitionMix} walls={walls} isLive={viewMode === 'live'} />}
                    {renderSVG(viewMode === 'live')}
                    {viewMode === '2d' && (
                        <div className="absolute top-4 left-4 pointer-events-none select-none drop-shadow-md z-50">
                            {menuTab === 'scenes' ? (
                                <div className="bg-black/50 px-3 py-2 rounded-lg backdrop-blur-sm">
                                    <div className="text-xs text-purple-300 font-bold uppercase tracking-wider">SCENE MODE</div>
                                    <div className="text-lg font-bold text-white">Act {currentSceneIndex + 1} - Cue {currentCueIndex + 1}</div>
                                </div>
                            ) : (<>
                                <div className="flex items-center gap-3">
                                    <div>
                                        <h1 className="text-xl font-bold tracking-wider text-white uppercase">MAPPING STUDIO</h1>
                                        <div className="flex gap-2 mt-1">
                                            <span className={`text-xs px-1.5 py-0.5 rounded font-mono border transition-colors ${moveMode ? 'bg-orange-600 border-orange-400 text-white' : 'bg-zinc-800 border-zinc-600 text-gray-200'}`}>M: Move All</span>
                                            <span className={`text-xs px-1.5 py-0.5 rounded font-mono border transition-colors ${showGuides ? 'bg-blue-900 border-blue-500 text-blue-200' : 'bg-zinc-800 border-zinc-600 text-gray-200'}`}>G: Guides</span>
                                            <span className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-gray-200 font-mono border border-zinc-600 uppercase">H: Menu</span>
                                        </div>
                                    </div>
                                    
                                    {usbDrives.length > 0 && (
                                        <button 
                                            onClick={() => setAssetBrowserState({ isOpen: true, type: 'image', callback: () => {} })}
                                            className="bg-orange-600 hover:bg-orange-500 text-white px-3 py-2 rounded-lg font-bold text-xs flex items-center gap-2 animate-bounce-subtle shadow-lg shadow-orange-900/40 pointer-events-auto"
                                        >
                                            <Cable size={16} /> USB DETECTED ({usbDrives.length})
                                        </button>
                                    )}
                                </div>
                            </>)}
                        </div>
                    )}
                </div>
            </div>

            {menuTab === 'scenes' && viewMode !== 'live' && showNodeEditor && (
                <div className="absolute bottom-0 left-0 right-0 h-[45%] z-30 border-t border-zinc-700/30 bg-zinc-900/50 backdrop-blur-md">
                    {!activeSelection.cueId ? (
                        <div className="w-full h-full flex items-center justify-center backdrop-blur-sm bg-black/20">
                            <div className="text-center bg-zinc-900/80 p-8 rounded-2xl border border-zinc-800 shadow-2xl">
                                <Workflow size={48} className="text-purple-500 mx-auto mb-4 opacity-50" />
                                <p className="text-gray-400 font-bold mb-2 uppercase tracking-widest">No Cue Selected</p>
                                <p className="text-xs text-gray-500 max-w-[200px] mx-auto mb-4">Please create or select an Act and a Cue in the sidebar to start mapping nodes.</p>
                                {scenes.length === 0 ? (
                                    <button onClick={addScene} className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded font-bold text-xs uppercase tracking-widest transition-all active:scale-95 shadow-lg shadow-purple-900/40">Create First Act</button>
                                ) : (
                                    <button onClick={() => addCue(scenes[0].id)} className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded font-bold text-xs uppercase tracking-widest transition-all active:scale-95 shadow-lg shadow-purple-900/40">Add Cue to {scenes[0].name}</button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
                            {activeSelection.type === 'cue' ? <NodeEditor activeSelection={activeSelection} currentCue={currentCueObj} updateCueData={updateCueData} walls={walls} setWalls={setWalls} onOpenAssetBrowser={(type, cb) => setAssetBrowserState({isOpen:true, type, callback:cb})} /> : <TransitionEditor cue={currentCueObj} updateCue={updateCueData} />}
                        </>
                    )}
                </div>
            )}

            {menuOpen && viewMode !== 'live' && (
                <div className="absolute right-4 top-4 bottom-4 w-64 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden">
                    <div className="p-4 pb-0">
                        <button 
                            onClick={() => {
                                setViewMode('live');
                                setMenuOpen(false);
                            }}
                            className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded-lg shadow-lg flex items-center justify-center gap-2 transition-transform hover:scale-105"
                        >
                            <Play size={20} fill="currentColor" /> GO LIVE
                        </button>
                    </div>
                    <div className="p-4 border-b border-zinc-700 flex justify-between items-center bg-zinc-900">
                        <span className="font-bold flex items-center gap-2"> <Settings size={18} /> Configuration </span>
                        <button onClick={() => setMenuOpen(false)} className="text-gray-400 hover:text-white">&times;</button>
                    </div>
                    <div className="flex border-b border-zinc-800 mt-4">
                        <button onClick={() => setMenuTab('config')} className={`flex-1 py-2 text-xs font-bold ${menuTab === 'config' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>Geometry</button>
                        <button onClick={() => setMenuTab('scenes')} className={`flex-1 py-2 text-xs font-bold ${menuTab === 'scenes' ? 'text-purple-400 border-b-2 border-purple-400' : 'text-gray-500 hover:text-gray-300'}`}>Scenes</button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-6">
                        {menuTab === 'config' && (
                            <>
                                {viewMode === '2d' && (<div className="grid grid-cols-2 gap-2"><button onClick={() => setMoveMode(p => !p)} className={`p-2 rounded text-xs flex items-center justify-center gap-1 border transition-colors ${moveMode ? 'bg-orange-600 border-orange-400 text-white' : 'bg-zinc-800 border-zinc-700 text-gray-300'}`}> <Move size={14} /> Move (M) </button><button onClick={() => setShowGuides(p => !p)} className={`p-2 rounded text-xs flex items-center justify-center gap-1 border transition-colors ${showGuides ? 'bg-blue-900/50 border-blue-500 text-blue-200' : 'bg-zinc-800 border-zinc-700 text-gray-300'}`}> <Grid3X3 size={14} /> Guide (G) </button></div>)}
                                {activeWall && (
                                    <div className="space-y-3 bg-zinc-900 border border-zinc-700 p-3 rounded-lg">
                                        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-800">
                                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: activeWall.color }}></div>
                                            <input type="text" value={activeWall.name} onChange={(e) => setWalls(p => p.map(w => w.id === activeWall.id ? { ...w, name: e.target.value } : w))} className="bg-transparent border-none outline-none text-sm font-bold text-white w-full" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 mt-1">
                                            <div>
                                                <label className="text-[10px] text-gray-500 flex items-center gap-1 mb-1"><Folder size={10}/> Group</label>
                                                <CustomSelect value={activeWall.folderId || ""} onChange={(val) => setWalls(p => p.map(w => w.id === activeWall.id ? { ...w, folderId: val ? parseInt(val) : null } : w))} buttonClassName="bg-zinc-800 border-zinc-700 px-2 py-1 text-xs" options={[{ value: "", label: "None" }, ...folders.map(f => ({ value: f.id, label: f.name }))]} />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-gray-500 flex items-center gap-1 mb-1"><Palette size={10}/> Color</label>
                                                <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 h-7">
                                                    <ColorPicker value={activeWall.color} onChange={(val) => setWalls(p => p.map(w => w.id === activeWall.id ? { ...w, color: val } : w))} className="w-4 h-4" />
                                                    <span className="text-xs text-gray-400 font-mono">{activeWall.color}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <h3 className="text-xs font-bold text-gray-500">OBJECTS</h3>
                                        <div className="flex gap-1">
                                            <button onClick={addFolder} className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded flex items-center gap-1" title="New Group"> <FolderPlus size={12} /> </button>
                                            <button onClick={() => { const newId = Math.max(0, ...walls.map(w => w.id)) + 1; setWalls(p => [...p, { id: newId, name: `Obj ${newId}`, color: `hsl(${Math.random()*360},70%,60%)`, folderId: null, points: [{x:300,y:300},{x:400,y:300},{x:400,y:400},{x:300,y:400}] }]); }} className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded flex items-center gap-1" title="New Object"> <Plus size={12} /> </button>
                                        </div>
                                    </div>
                                    {folders.map(folder => (<FolderItem key={folder.id} folder={folder} walls={walls} activeWallId={activeWallId} setActiveWallId={setActiveWallId} setWalls={setWalls} setFolders={setFolders} moveWall={moveWall} deleteWall={deleteWall} showConfirm={showConfirm} />))}
                                    {walls.filter(w => w.folderId === null).map(wall => (<WallItem key={wall.id} wall={wall} activeWallId={activeWallId} setActiveWallId={setActiveWallId} moveWall={moveWall} deleteWall={deleteWall} />))}
                                </div>
                                
                                <WallStackVisualizer walls={walls} activeWallId={activeWallId} />

                                <div className="mt-4 pt-4 border-t border-zinc-700">
                                    <button onClick={() => setShowProjectManager(true)} className="w-full bg-zinc-800 hover:bg-zinc-700 text-gray-300 py-2 rounded text-xs font-bold flex items-center justify-center gap-2"><Database size={14}/> Manage Projects</button>
                                </div>
                            </>
                        )}

                        {menuTab === 'scenes' && (
                            <div className="space-y-4">
                                <div className="flex gap-2 border-b border-zinc-800 pb-2 mb-2">
                                    <button onClick={() => setShowNodeEditor(p => !p)} className={`w-full p-2 rounded text-xs flex items-center justify-center gap-1 border transition-colors ${showNodeEditor ? 'bg-purple-900/50 border-purple-500 text-purple-200' : 'bg-zinc-800 border-zinc-700 text-gray-300'}`} title="Toggle Node Editor">
                                        {showNodeEditor ? <Eye size={14}/> : <EyeOff size={14}/>} {showNodeEditor ? 'Hide Graph' : 'Show Graph'}
                                    </button>
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between items-center mb-2">
                                        <h3 className="text-xs font-bold text-gray-400 uppercase">Cue List</h3>
                                        <button onClick={addScene} className="text-xs bg-purple-600 hover:bg-purple-500 px-2 py-1 rounded flex items-center gap-1 text-white ml-2"><Plus size={12}/> Act</button>
                                    </div>
                                    {scenes.map((scene, sIdx) => (
                                        <div key={scene.id} className="mb-3">
                                            <div className="px-2 py-1 text-xs font-bold text-gray-500 uppercase border-b border-zinc-800 mb-1 flex justify-between items-center">
                                                <span className="flex items-center gap-2"><Film size={10}/> {scene.name}</span>
                                                <div className="flex items-center gap-1">
                                                    <button onClick={() => moveScene(sIdx, -1)} className="text-gray-500 hover:text-white p-0.5"><ChevronUp size={12}/></button>
                                                    <button onClick={() => moveScene(sIdx, 1)} className="text-gray-500 hover:text-white p-0.5"><ChevronDown size={12}/></button>
                                                    <button onClick={() => deleteScene(scene.id)} className="text-gray-500 hover:text-red-400 p-0.5" title="Delete Act"><Trash2 size={12}/></button>
                                                    <button onClick={() => addCue(scene.id)} className="text-[9px] bg-zinc-800 hover:bg-zinc-700 px-1.5 py-0.5 rounded text-gray-300 ml-1">+ Cue</button>
                                                </div>
                                            </div>
                                            <div className="space-y-0 pl-1">
                                                {scene.cues.map((cue, cIdx) => {
                                                    const isActive = activeSelection.type === 'cue' && activeSelection.sceneId === scene.id && activeSelection.cueId === cue.id;
                                                    
                                                    // Find the next cue, even if it's in the next Act
                                                    let nextCue = scene.cues[cIdx + 1];
                                                    let nextSceneId = scene.id;
                                                    if (!nextCue && scenes[sIdx + 1]) {
                                                        nextCue = scenes[sIdx + 1].cues[0];
                                                        nextSceneId = scenes[sIdx + 1].id;
                                                    }

                                                    return (
                                                        <div key={cue.id}>
                                                            <div onClick={() => setActiveSelection({ type: 'cue', sceneId: scene.id, cueId: cue.id })} className={`flex items-center gap-2 p-2 rounded text-xs cursor-pointer transition-all group ${isActive ? 'bg-purple-900/50 border-l-2 border-purple-400 text-white' : 'hover:bg-zinc-800 text-gray-400 border-l-2 border-transparent'}`}>
                                                                {isActive ? <Play size={10} fill="currentColor"/> : <span className="w-2.5"/>}
                                                                <span className="truncate flex-1">{cue.name}</span>
                                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <button onClick={(e) => { e.stopPropagation(); moveCue(scene.id, cIdx, -1); }} className="text-gray-500 hover:text-white p-0.5"><ChevronUp size={10}/></button>
                                                                    <button onClick={(e) => { e.stopPropagation(); moveCue(scene.id, cIdx, 1); }} className="text-gray-500 hover:text-white p-0.5"><ChevronDown size={10}/></button>
                                                                    <button onClick={(e) => { e.stopPropagation(); deleteCue(scene.id, cue.id); }} className="text-gray-500 hover:text-red-400 p-0.5" title="Delete Cue"><Trash2 size={10}/></button>
                                                                </div>
                                                            </div>
                                                            {nextCue && (
                                                                <div className={`h-2 my-0.5 rounded-full mx-2 cursor-pointer hover:bg-purple-500/50 transition-colors group relative flex justify-center items-center ${activeSelection.type === 'transition' && activeSelection.nextCueId === nextCue.id ? 'bg-purple-500' : 'bg-zinc-800'}`} onClick={() => setActiveSelection({ type: 'transition', sceneId: nextSceneId, prevCueId: cue.id, nextCueId: nextCue.id, cueId: nextCue.id })}>
                                                                    <div className="w-3 h-3 rounded-full bg-zinc-600 border border-zinc-900 group-hover:bg-white group-hover:scale-125 transition-transform flex items-center justify-center"><Link size={8} className="text-zinc-900"/></div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="mt-4 pt-4 border-t border-zinc-700">
                                    <button 
                                        onClick={() => setAssetBrowserState({ isOpen: true, type: 'image', callback: () => {} })} 
                                        className="w-full bg-zinc-800 hover:bg-zinc-700 text-gray-300 py-2 rounded text-xs font-bold flex items-center justify-center gap-2"
                                    >
                                        <Folder size={14}/> Asset Library
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
            <Modal {...modal} onCancel={() => setModal(prev => ({ ...prev, isOpen: false }))} />
        </div>
    );
}