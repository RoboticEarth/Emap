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

    const animateTransition = useCallback((time) => {
        if (!startTimeRef.current) startTimeRef.current = time;
        const duration = (transitionDetailsRef.current?.transitionDuration || 0) * 1000;
        const delay = (transitionDetailsRef.current?.transitionDelay || 0) * 1000;
        const totalDuration = duration + delay;
        
        const elapsed = time - startTimeRef.current;
        
        let mix = 1;
        if (totalDuration > 0) {
            if (elapsed < delay) mix = 0;
            else mix = duration > 0 ? Math.min((elapsed - delay) / duration, 1) : 1;
        }
        
        const ease = transitionDetailsRef.current?.transitionEase || 'linear';
        setTransitionMix(getEase(mix, ease));

        if (elapsed < totalDuration) { requestRef.current = requestAnimationFrame(animateTransition); }
        else { setTransitionMix(1); setPrevCueState(null); }
    }, []);

    useEffect(() => {
        if (currentCueObjRef.current) {
            // Only start transition if previous state was different
            if (prevCueObjRef.current && JSON.stringify(prevCueObjRef.current) !== JSON.stringify(currentCueObjRef.current)) {
                setPrevCueState(prevCueObjRef.current); // Save the old cue state
                setTransitionMix(0); // Start mix from 0 for new transition
                startTimeRef.current = null;
                cancelAnimationFrame(requestRef.current);
                requestRef.current = requestAnimationFrame(animateTransition);
            } else if (!prevCueObjRef.current) {
                // No previous state, directly set current (first load)
                setTransitionMix(1);
                setPrevCueState(null);
            }
            // Update the previous cue for the next comparison
            prevCueObjRef.current = currentCueObjRef.current;
            setCurrentCueState(currentCueObjRef.current);
        } else {
            // No current cue, clear everything
            setPrevCueState(null);
            setCurrentCueState(null);
            setTransitionMix(1);
            cancelAnimationFrame(requestRef.current);
        }
    }, [activeSelection, projectData, animateTransition]); // Re-run when activeSelection or projectData changes

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
                    if (configFailureCount.current >= 5) {
                        console.log("[PROJECTION] Monitor config missing, redirecting to setup...");
                        window.location.reload();
                    }
                } else {
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

    // Update currentCueObjRef.current and transitionDetailsRef.current whenever relevant state changes
    useEffect(() => {
        if (projectData && activeSelection) {
            const cue = getCueData(projectData.scenes, activeSelection.sceneId, activeSelection.cueId);
            currentCueObjRef.current = cue;
            transitionDetailsRef.current = cue; // Transition details are part of the cue object
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
        <div className="w-full h-full relative font-sans text-white bg-black">
            <ProjectionContent 
                walls={walls} 
                currentCueState={currentCueState} 
                prevCueState={prevCueState}
                transitionMix={transitionMix}
                viewMode={viewMode}
                menuTab={uiSync.menuTab}
                showGuides={uiSync.showGuides}
                activeWallId={uiSync.activeWallId}
            />
        </div>
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Projection />
    </React.StrictMode>
);