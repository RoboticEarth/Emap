import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { db } from './lib/persistence'; // Import the persistence manager
import { ProjectionContent } from './components/ProjectionContent'; // Import the new component
import { getEase } from './components/ProjectionContent'; // Import getEase for transitions

function Projection() {
    const [projectData, setProjectData] = useState(null);
    const [activeSelection, setActiveSelection] = useState({ type: 'cue', sceneId: null, cueId: null });
    const [uiSync, setUiSync] = useState({ viewMode: 'live', menuTab: 'scenes', showGuides: false, activeWallId: null });
    const [isLoading, setIsLoading] = useState(true);
    const configFailureCount = useRef(0);
    
    const [prevCueState, setPrevCueState] = useState(null);
    const [currentCueState, setCurrentCueState] = useState(null);
    const [transitionMix, setTransitionMix] = useState(1);
    const requestRef = useRef();
    const startTimeRef = useRef();

    const currentCueObjRef = useRef(null);
    const prevCueObjRef = useRef(null);
    const transitionDetailsRef = useRef(null);

    const animateTransition = (time) => {
        if (!startTimeRef.current) startTimeRef.current = time;
        const cue = transitionDetailsRef.current;
        const duration = (cue?.transitionDuration ?? 1) * 1000;
        const delay = (cue?.transitionDelay || 0) * 1000;
        const totalDuration = duration + delay;
        
        const elapsed = time - startTimeRef.current;
        
        if (totalDuration <= 0) {
            setTransitionMix(1);
            setPrevCueState(null);
            return;
        }

        let mix = 0;
        if (elapsed < delay) mix = 0;
        else mix = duration > 0 ? Math.min((elapsed - delay) / duration, 1) : 1;
        
        const ease = cue?.transitionEase || 'linear';
        setTransitionMix(getEase(mix, ease));

        if (elapsed < totalDuration) { 
            requestRef.current = requestAnimationFrame(animateTransition); 
        } else { 
            setTransitionMix(1); 
            setPrevCueState(null); 
        }
    };

    const getCueData = useCallback((scenes, sId, cId) => {
        if (!scenes || !sId || !cId) return null;
        const s = scenes.find(x => x.id === sId);
        return s ? s.cues.find(x => x.id === cId) : null;
    }, []);

    const [scale, setScale] = useState(1);
    const [isMuted, setIsMuted] = useState(false);

    const [monitors, setMonitors] = useState([]);
    const [screenName, setScreenName] = useState(null);
    const [stageSize, setStageSize] = useState({ w: 1777.7, h: 1000 });

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const sName = params.get('screen');
        console.log("[PROJECTION] Initializing for screen:", sName);
        if (params.get('mute') === '1') {
            setIsMuted(true);
        }
        setScreenName(sName);

        const updateScale = () => {
            setStageSize(prev => {
                const scaleH = window.innerHeight / prev.h;
                const scaleW = window.innerWidth / prev.w;
                setScale(Math.min(scaleH, scaleW));
                return prev;
            });
        };
        window.addEventListener('resize', updateScale);
        updateScale();
        return () => window.removeEventListener('resize', updateScale);
    }, []);

    useEffect(() => {
        if (screenName && monitors.length > 0) {
            const currentMonitor = monitors.find(m => m.name === screenName);
            if (currentMonitor) {
                const ar = currentMonitor.width / currentMonitor.height;
                const newW = 1000 * ar;
                setStageSize({ w: newW, h: 1000 });
                
                // Update scale immediately with new stage size
                const scaleH = window.innerHeight / 1000;
                const scaleW = window.innerWidth / newW;
                setScale(Math.min(scaleH, scaleW));
                console.log("[PROJECTION] Stage size updated for", screenName, ":", newW, "x 1000");
            }
        }
    }, [screenName, monitors]);

    // Use a ref for projectData to avoid effect re-triggering during poll
    const projectDataRef = useRef(null);

    useEffect(() => {
        const loadAndPollData = async () => {
            try {
                const res = await fetch('/api/sync');
                if (!res.ok) return;
                
                const sync = await res.json();
                
                // Update Monitors - Only if changed to prevent loops
                if (sync.discovered_monitors) {
                    setMonitors(prev => {
                        if (JSON.stringify(prev) === JSON.stringify(sync.discovered_monitors)) return prev;
                        return sync.discovered_monitors;
                    });
                }

                // Update Project Data
                if (sync.project_data) {
                    projectDataRef.current = sync.project_data;
                    setProjectData(sync.project_data);
                } else {
                    projectDataRef.current = { walls: [], folders: [], scenes: [] };
                    setProjectData({ walls: [], folders: [], scenes: [] });
                }

                // Update Active Selection
                if (sync.active_selection) {
                    setActiveSelection(sync.active_selection);
                }

                // Update UI Sync State
                if (sync.ui_sync) {
                    setUiSync(sync.ui_sync);
                }

                // Monitor config reset check
                if (!sync.monitor_config) {
                    configFailureCount.current++;
                    if (configFailureCount.current >= 5) {
                        window.location.reload();
                    }
                } else {
                    configFailureCount.current = 0;
                }
            } catch (error) {
                console.error("[PROJECTION ERROR] Failed to load sync data:", error);
            } finally {
                setIsLoading(false);
            }
        };

        loadAndPollData(); // Initial load
        const intervalId = setInterval(loadAndPollData, 100); // 10Hz sync
        return () => clearInterval(intervalId);
    }, []); // Empty dependency array means this only runs once on mount

    useEffect(() => {
        if (projectData && activeSelection) {
            const cue = getCueData(projectData.scenes, activeSelection.sceneId, activeSelection.cueId);
            
            if (cue) {
                const isDifferentCue = !prevCueObjRef.current || prevCueObjRef.current.id !== cue.id;
                
                if (isDifferentCue) {
                    console.log("[PROJECTION] Cue changed to:", cue.id, cue.name);
                    const duration = (cue?.transitionDuration ?? 1) * 1000;
                    const delay = (cue?.transitionDelay || 0) * 1000;
                    
                    if (prevCueObjRef.current && (duration + delay) > 0) {
                        let startState = (currentCueState || prevCueState);
                        
                        if (activeSelection.type === 'transition' && activeSelection.prevCueId) {
                             const prevCue = projectData.scenes.find(s => s.id === activeSelection.sceneId)?.cues.find(c => c.id === activeSelection.prevCueId);
                             if (prevCue) startState = prevCue;
                        }

                        setPrevCueState(startState);
                        setCurrentCueState(cue);
                        setTransitionMix(0); 
                        startTimeRef.current = null;
                        cancelAnimationFrame(requestRef.current);
                        transitionDetailsRef.current = cue;
                        requestRef.current = requestAnimationFrame(animateTransition);
                    } else {
                        setPrevCueState(null);
                        setCurrentCueState(cue);
                        setTransitionMix(1);
                    }
                } else {
                    // Same cue, update current state data (for live editing)
                    setCurrentCueState(cue);
                }
                prevCueObjRef.current = cue;
            } else {
                if (currentCueState) {
                    console.log("[PROJECTION] Active cue is now null (No cue found for", activeSelection.sceneId, activeSelection.cueId, ")");
                    setCurrentCueState(null);
                    prevCueObjRef.current = null;
                }
            }
        }
        return () => cancelAnimationFrame(requestRef.current);
    }, [projectData, activeSelection, getCueData]);


    if (isLoading) {
        return (
            <div className="bg-black text-white flex items-center justify-center h-screen font-sans">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-blue-500 mb-4">Emap Projection</h1>
                    <p className="text-gray-400">Loading Configuration...</p>
                </div>
            </div>
        );
    }

    // Prepare data for ProjectionContent
    const walls = projectData?.walls || [];
    const viewMode = uiSync.viewMode;
    
    return (
        <div className="w-full h-full relative font-sans text-white bg-black overflow-hidden">
            {/* Debug Overlay - ALWAYS VISIBLE for diagnosis */}
            <div className="absolute top-4 left-4 z-[1000] bg-zinc-900/90 border-2 border-blue-500 p-4 rounded-lg text-xs font-mono text-blue-400 pointer-events-none shadow-2xl">
                <div className="font-bold mb-2 border-b border-blue-800 pb-1 flex justify-between">
                    <span>Emap Projection Debug</span>
                    <span className="animate-pulse">● LIVE</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <div className="text-zinc-500">Screen:</div><div>{screenName || 'Detecting...'}</div>
                    <div className="text-zinc-500">Project:</div><div>{projectData?.name || 'NONE LOADED'}</div>
                    <div className="text-zinc-500">Walls:</div><div>{walls.length}</div>
                    <div className="text-zinc-500">Mode:</div><div>{viewMode}</div>
                    <div className="text-zinc-500">Sync Tab:</div><div>{uiSync.menuTab}</div>
                    <div className="text-zinc-500">Scene ID:</div><div className="truncate max-w-[100px]">{activeSelection?.sceneId || 'NULL'}</div>
                    <div className="text-zinc-500">Cue ID:</div><div className="truncate max-w-[100px]">{activeSelection?.cueId || 'NULL'}</div>
                    <div className="text-zinc-500">Render State:</div><div>{currentCueState ? 'CONTENT ACTIVE' : 'NO CONTENT'}</div>
                    <div className="text-zinc-500">Mix:</div><div>{transitionMix.toFixed(2)}</div>
                </div>
            </div>

            <div style={{ 
                transform: `translate(-50%, -50%) scale(${scale})`, 
                transformOrigin: 'center center', 
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: `${stageSize.w}px`, 
                height: `${stageSize.h}px` 
            }}>
                <ProjectionContent 
                    walls={walls} 
                    currentCueState={currentCueState} 
                    prevCueState={prevCueState}
                    transitionMix={transitionMix}
                    viewMode={viewMode}
                    menuTab={uiSync.menuTab}
                    showGuides={uiSync.showGuides}
                    activeWallId={uiSync.activeWallId}
                    isMuted={isMuted}
                />
            </div>
        </div>
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Projection />
    </React.StrictMode>
);