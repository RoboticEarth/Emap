import React, { useRef, useEffect, useMemo } from 'react';
import { solveHomography, applyHomography, getCssMatrix, getDistance } from '../lib/math';
import { ProceduralLib } from '../lib/procedural';
import { ColorUtils } from '../lib/color';

// Utility for easing functions (copied from App.jsx)
export const getEase = (t, type) => {
    if (t < 0) return 0;
    if (t > 1) return 1;
    switch (type) {
        case 'easeIn': return t * t;
        case 'easeOut': return t * (2 - t);
        case 'easeInOut': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        default: return t;
    }
};

// Utility to interpolate node data (copied from App.jsx)
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

// NoiseCanvas component (copied from App.jsx)
const NoiseCanvas = ({ type = 'perlin', scale = 5, detail = 4, time = 0, distortion = 0, isAnimating = false, animSpeed = 0.1 }) => {
    const canvasRef = useRef(null);
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

// RenderNode component (copied from App.jsx)
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


// TransitioningProjectedContent component (copied from App.jsx)
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

// WallBackgroundLayer component (copied from App.jsx)
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

// WarpedTextureGrid (copied from App.jsx)
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

// Main ProjectionContent Component
export const ProjectionContent = ({ walls, currentCueState, prevCueState, transitionMix, viewMode, menuTab, showGuides, activeWallId }) => {
    const isLive = viewMode === 'live';
    const isTransitioning = transitionMix < 1;

    return (
        <div className="absolute inset-0 h-full z-0 bg-black">
            <WallBackgroundLayer walls={walls} currentCueState={currentCueState} isLive={isLive} isTransitioning={isTransitioning} shouldShow={menuTab === 'scenes'} />
            <TransitioningProjectedContent prevCueState={prevCueState} currentCueState={currentCueState} mix={transitionMix} walls={walls} isLive={isLive} />
            
            {/* SVG Overlay for Mapping Geometry */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <defs>
                     <pattern id="smallGrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5"/></pattern>
                     <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#smallGrid)"/><path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1"/></pattern>
                </defs>
                
                {showGuides && !isLive && menuTab !== 'scenes' && (
                    <>
                        <rect width="100%" height="100%" fill="url(#grid)" />
                        <line x1="50%" y1="0" x2="50%" y2="100%" stroke="cyan" strokeOpacity="0.5" strokeDasharray="5,5" />
                        <line x1="0" y1="50%" x2="100%" y2="50%" stroke="cyan" strokeOpacity="0.5" strokeDasharray="5,5" />
                    </>
                )}

                {walls.map(wall => {
                    const isSelected = wall.id === activeWallId;
                    const baseOpacity = isLive ? 1 : (isSelected ? 0.5 : 0.1);
                    const isProjecting = (isLive || menuTab === 'scenes') && currentCueState?.nodes?.some(n => n.type === 'output' && n.data.wallId === wall.id && currentCueState.connections?.some(c => c.to === n.id));

                    return (
                        <g key={wall.id}>
                            {/* If not live and not scene mode, show the mapping outlines */}
                            {!isLive && menuTab !== 'scenes' && (
                                <>
                                    <path 
                                        d={`M ${wall.points[0].x} ${wall.points[0].y} L ${wall.points[1].x} ${wall.points[1].y} L ${wall.points[2].x} ${wall.points[2].y} L ${wall.points[3].x} ${wall.points[3].y} Z`} 
                                        fill={wall.color} 
                                        fillOpacity={baseOpacity} 
                                        stroke={wall.color} 
                                        strokeWidth={isSelected ? 2 : 1} 
                                        strokeDasharray="5,5" 
                                    />
                                    {showGuides && (
                                        <g>
                                            <line x1={wall.points[0].x} y1={wall.points[0].y} x2={wall.points[2].x} y2={wall.points[2].y} stroke="cyan" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="4,4" />
                                            <line x1={wall.points[1].x} y1={wall.points[1].y} x2={wall.points[3].x} y2={wall.points[3].y} stroke="cyan" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="4,4" />
                                        </g>
                                    )}
                                </>
                            )}
                            
                            {/* Special case: Test Grid (Texture mapping test) */}
                            {isLive && currentCueState?.type === 'test' && (
                                <WarpedTextureGrid wallPoints={wall.points} />
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
};

// Also export ProceduralLib and ColorUtils if they are used directly in any sub-components that get passed here
// For now, they are only used within NoiseCanvas, so direct export might not be needed unless used elsewhere.
// But it's good practice to ensure all dependencies are resolved.
export { ProceduralLib, ColorUtils };
