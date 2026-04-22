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

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get('mute') === '1') {
            setIsMuted(true);
        }

        const updateScale = () => {
            const scaleH = window.innerHeight / 1000;
            const scaleW = window.innerWidth / 1777.7;
            setScale(Math.min(scaleH, scaleW));
        };
        window.addEventListener('resize', updateScale);
        updateScale();
        return () => window.removeEventListener('resize', updateScale);
    }, []);

    const animateTransition = useCallback((time) => {
        if (!startTimeRef.current) startTimeRef.current = time;
        // Default to 1.0s if not specified
        const duration = (transitionDetailsRef.current?.transitionDuration ?? 1) * 1000;
        const delay = (transitionDetailsRef.current?.transitionDelay || 0) * 1000;
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
        
        const ease = transitionDetailsRef.current?.transitionEase || 'linear';
        setTransitionMix(getEase(mix, ease));

        if (elapsed < totalDuration) { 
            requestRef.current = requestAnimationFrame(animateTransition); 
        } else { 
            setTransitionMix(1); 
            setPrevCueState(null); 
        }
    }, []);

    useEffect(() => {
        if (currentCueObjRef.current) {
            // Only start transition if it's a DIFFERENT cue than before
            const isDifferentCue = !prevCueObjRef.current || prevCueObjRef.current.id !== currentCueObjRef.current.id;
            
            if (isDifferentCue) {
                // Default to 1.0s if not specified
                const duration = (currentCueObjRef.current?.transitionDuration ?? 1) * 1000;
                const delay = (currentCueObjRef.current?.transitionDelay || 0) * 1000;
                
                if (prevCueObjRef.current && (duration + delay) > 0) {
                    setPrevCueState(prevCueObjRef.current);
                    setTransitionMix(0);
                    startTimeRef.current = null;
                    cancelAnimationFrame(requestRef.current);
                    requestRef.current = requestAnimationFrame(animateTransition);
                } else {
                    setTransitionMix(1);
                    setPrevCueState(null);
                }
            }
            // Update current state and prev cue for comparison
            prevCueObjRef.current = currentCueObjRef.current;
            setCurrentCueState(currentCueObjRef.current);
        } else {
            setPrevCueState(null);
            setCurrentCueState(null);
            setTransitionMix(1);
            cancelAnimationFrame(requestRef.current);
        }
    }, [activeSelection, projectData, animateTransition]);

    useEffect(() => {
        const loadAndPollData = async () => {
            try {
                const res = await fetch('/api/sync');
                if (!res.ok) return;
                
                const sync = await res.json();
                
                // Update Project Data
                if (sync.project_data) {
                    setProjectData(sync.project_data);
                } else if (!projectData) {
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

                // Monitor config reset check (if it was once present but now null)
                if (!sync.monitor_config) {
                    configFailureCount.current++;
                    console.warn(`[PROJECTION] Sync check failed: Monitor config missing in sync (${configFailureCount.current}/5)`);
                    if (configFailureCount.current >= 5) {
                        console.error("[PROJECTION] Monitor configuration LOST. Reloading to trigger Setup...");
                        window.location.reload();
                    }
                } else {
                    if (configFailureCount.current > 0) console.log("[PROJECTION] Sync check recovered.");
                    configFailureCount.current = 0;
                }
                
                setIsLoading(false);
            } catch (error) {
                console.error("Failed to load projection data:", error);
                // Don't set isLoading(false) on the first error to keep the spinner 
                // until we get a successful sync.
            }
        };

        loadAndPollData(); // Initial load

        const intervalId = setInterval(loadAndPollData, 100); // 10Hz sync
        return () => clearInterval(intervalId); // Cleanup interval on unmount
    }, [projectData]);

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
                width: '1777.7px', 
                height: '1000px' 
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