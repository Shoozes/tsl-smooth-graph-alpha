const freezePresetMap=(presets)=>Object.freeze(Object.fromEntries(Object.entries(presets).map(([id,preset])=>[id,Object.freeze({id,...preset})])));

export const motionScenes=freezePresetMap({
  signal:{label:'Signal Choreography',search:'signal-relay',replay:'weave'},
  lens:{label:'Semantic Lens',search:'semantic-lens',replay:'orbit'},
  director:{label:'Graph Director',search:'evidence-walk',replay:'score'}
});

export const searchMotionPresets=freezePresetMap({
  'signal-relay':{label:'Signal relay',family:'signal',effect:'relay',limit:24,intervalMs:150,staggerMs:0,peak:1.24,durationMs:500,trace:'signal',cameraPath:'arc-right',cameraDurationMs:950},
  'semantic-lens':{label:'Semantic lens',family:'lens',effect:'lens',limit:64,intervalMs:0,staggerMs:26,peak:1.18,durationMs:720,trace:'ripple',cameraPath:'direct',cameraDurationMs:900},
  'evidence-walk':{label:'Evidence walk',family:'director',effect:'walk',limit:18,intervalMs:240,staggerMs:0,peak:1.3,durationMs:620,trace:'director',cameraPath:'arc-over',cameraDurationMs:1350},
  bloom:{label:'Constellation bloom',family:'classic',effect:'bloom',limit:48,intervalMs:0,staggerMs:20,peak:1.18,durationMs:560,trace:false,cameraPath:'direct',cameraDurationMs:760},
  instant:{label:'Instant',family:'classic',effect:'instant',limit:0,intervalMs:0,staggerMs:0,peak:1,durationMs:1,trace:false,cameraPath:'direct',cameraDurationMs:1}
});

export const replayPresets=freezePresetMap({
  weave:{label:'Constellation weave',family:'signal',strategy:'parent',title:'CONSTELLATION WEAVE',preparing:'Preparing constellation weave…',running:'Weaving the corpus…',trace:'signal',cameraPath:'arc-over',batchMinimum:7,batchDivisor:74,stepMs:48,settleMs:820,positionDurationMs:780,nodeFrom:.035,nodeDurationMs:660,nodeDelayMs:12,nodeOvershoot:2.15},
  orbit:{label:'Orbit assembly',family:'lens',strategy:'orbit',title:'ORBIT ASSEMBLY',preparing:'Preparing orbital assembly…',running:'Assembling semantic orbits…',trace:'ripple',cameraPath:'arc-right',batchMinimum:6,batchDivisor:82,stepMs:55,settleMs:900,positionDurationMs:920,nodeFrom:.12,nodeDurationMs:760,nodeDelayMs:15,nodeOvershoot:1.42},
  score:{label:'Archive score',family:'director',strategy:'score',title:'ARCHIVE SCORE',preparing:'Preparing archive score…',running:'Scoring the archive in depth…',trace:'director',cameraPath:'arc-over',batchMinimum:3,batchDivisor:170,stepMs:76,settleMs:980,positionDurationMs:980,nodeFrom:.34,nodeDurationMs:720,nodeDelayMs:18,nodeOvershoot:1.18},
  bloom:{label:'Obsidian bloom',family:'classic',strategy:'parent',title:'OBSIDIAN BLOOM',preparing:'Preparing 3D graph bloom…',running:'Blooming the corpus…',trace:false,cameraPath:false,batchMinimum:8,batchDivisor:66,stepMs:44,settleMs:850,positionDurationMs:760,nodeFrom:.025,nodeDurationMs:640,nodeDelayMs:12,nodeOvershoot:2.35},
  trace:{label:'Cinematic trace',family:'classic',strategy:'parent',title:'CINEMATIC TRACE',preparing:'Preparing cinematic trace…',running:'Tracing the corpus…',trace:'signal',cameraPath:'arc-over',batchMinimum:2,batchDivisor:210,stepMs:72,settleMs:950,positionDurationMs:900,nodeFrom:.42,nodeDurationMs:680,nodeDelayMs:18,nodeOvershoot:1.16},
  stream:{label:'Structure stream',family:'classic',strategy:'stream',title:'STRUCTURE STREAM',preparing:'Preparing structured corpus build…',running:'Streaming corpus structure…',trace:false,cameraPath:false,batchMinimum:10,batchDivisor:54,stepMs:52,settleMs:480,positionDurationMs:0,nodeFrom:1,nodeDurationMs:430,nodeDelayMs:8,nodeOvershoot:1}
});

export const tempoPresets=freezePresetMap({
  calm:{label:'Calm',scale:1.3},
  standard:{label:'Standard',scale:1},
  fast:{label:'Fast',scale:.7}
});

export function resolveMotionScene(searchMode,replayMode){
  return Object.values(motionScenes).find((scene)=>scene.search===searchMode&&scene.replay===replayMode)?.id;
}

export function durationForTempo(milliseconds,tempo='standard'){
  const scale=tempoPresets[tempo]?.scale??tempoPresets.standard.scale;
  return Math.max(0,Math.round(milliseconds*scale));
}
