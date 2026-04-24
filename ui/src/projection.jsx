import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { db } from './lib/persistence'; // Import the persistence manager
import { ProjectionContent } from './components/ProjectionContent'; // Import the new component
import { getEase } from './components/ProjectionContent'; // Import getEase for transitions

function Projection() {
    const [projectData, setProjectData] = useState(null);
    const [activeSelection, setActiveSelection] = useState(null);
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
        if (params.get('mute') === '1') {
            setIsMuted(true);
        }
        setScreenName(params.get('screen'));

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
                
                // Update Monitors
                if (sync.discovered_monitors) {
                    setMonitors(sync.discovered_monitors);
                }

                // Update Project Data
                if (sync.project_data) {
                    projectDataRef.current = sync.project_data;
                    setProjectData(sync.project_data);
                } else if (!projectDataRef.current) {
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
                
                setIsLoading(false);
            } catch (error) {
                console.error("Failed to load projection data:", error);
            }
        };

        loadAndPollData(); // Initial load
        const intervalId = setInterval(loadAndPollData, 100); // 10Hz sync
        return () => clearInterval(intervalId);
    }, []); // Empty dependency array means this only runs once on mount

    useEffect(() => {
        if (projectData && activeSelection) {
            const cue = getCueData(projectData.scenes, activeSelection.sceneId, activeSelection.cueId);
            
            // Fix: Use the INCOMING cue for transition settings
            transitionDetailsRef.current = cue;
            currentCueObjRef.current = cue;
        } else {
            currentCueObjRef.current = null;
            transitionDetailsRef.current = null;
        }
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