import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createForceGraph3D, createThreePlatform, NodeFlags } from '@ours/forcegraph-tsl';
import { coolStateTheme, metallicNodeSurface } from '../showcase/showcase-model.js';
import { cameraArcPath, createCameraAnimator, orbitCameraPose, zoomCameraPose } from '../showcase/examples/runtime/camera-controls.js';
import { createNodeSpawnMotion, parentRelativePosition } from '../showcase/examples/runtime/node-spawn-motion.js';
import { buildCorpusGraph, corpusMainHub, createCorpusViews, loadCorpusManifest } from './corpus-model.js';
import { createNodePositionMotion } from './node-position-motion.js';
import { durationForTempo, motionScenes, replayPresets, resolveMotionScene, searchMotionPresets, tempoPresets } from './motion-presets.js';
import { corpusFramePoints, planCorpusFrame, spreadCorpusPositions } from './corpus-framing.js';
import { bindCorpusNavigation } from './corpus-navigation.js';

const elements={canvas:document.querySelector('canvas'),title:document.querySelector('[data-title]'),status:document.querySelector('[data-status]'),metrics:document.querySelector('[data-metrics]'),search:document.querySelector('[data-search]'),searchAnimation:document.querySelector('[data-search-animation]'),searchExit:document.querySelector('[data-search-exit]'),searchResults:document.querySelector('[data-search-results]'),traceLayer:document.querySelector('[data-trace-layer]'),replay:document.querySelector('[data-replay]'),replayType:document.querySelector('[data-replay-type]'),studio:document.querySelector('[data-studio]'),studioPanel:document.querySelector('[data-studio-panel]'),studioClose:document.querySelector('[data-studio-close]'),studioTitle:document.querySelector('[data-studio-title]'),studioDescription:document.querySelector('[data-studio-description]'),scenePresets:document.querySelector('[data-scene-presets]'),searchCues:document.querySelector('[data-search-cues]'),replayCues:document.querySelector('[data-replay-cues]'),tempoPresets:document.querySelector('[data-tempo-presets]'),trail:document.querySelector('[data-trail]'),trailValue:document.querySelector('[data-trail-value]'),motion:document.querySelector('[data-motion]'),types:document.querySelector('[data-types]'),overview:document.querySelector('[data-overview]'),reset:document.querySelector('[data-reset]'),ingest:document.querySelector('[data-ingest]'),ingestTitle:document.querySelector('[data-ingest-title]'),ingestLabel:document.querySelector('[data-ingest-label]'),ingestProgress:document.querySelector('[data-ingest-progress]'),selectedTitle:document.querySelector('[data-selected-title]'),selectedPath:document.querySelector('[data-selected-path]'),selectedDetail:document.querySelector('[data-selected-detail]')};
const parameters=new URLSearchParams(location.search);
const manifestPath='./sample-manifest.json';
window.__forcegraphCorpusProof={schema:'forcegraph_corpus_browser_v1',done:false,status:'running'};
const removers=[];
const transientTimers=new Set();
let graph,cameraAnimator,nodeMotion,positionMotion,model,manifest,hierarchyModel;
let typeOverlay=false;
const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
let fullMotion=!motionPreference.matches;
let motionOverridden=false;
let autoFrame=true;
let frameNodes;
let frameRadiusScale=1.15;
let resizeObserver;
let resizeFrame;
let nodeById=new Map();
let naturalModel;
let viewportSpread=true;
let viewportLayoutKey='';
let overviewCenter='root';
let mainHubId='corpus:root';
let replayMode='weave';
let replayToken=0;
let searchTimer;
let viewRefreshFrame;
let searchMotionToken=0;
let searchMode='signal-relay';
let tempoMode='standard';
let trailIntensity=.68;
let disposed=false;
const searchStateTheme=Object.freeze({...coolStateTheme,focused:Object.freeze({...coolStateTheme.focused,color:0xd8fbff,colorMix:.72,scale:1.72}),dimmed:Object.freeze({color:0x02050a,colorMix:.94,scale:.44}),incidentLinks:Object.freeze({dimmed:Object.freeze({color:0x02050a,colorMix:.92,scale:.1})})});

try{
  manifest=await loadCorpusManifest(manifestPath);
  model=buildCorpusGraph(manifest);
  naturalModel=model;
  mainHubId=corpusMainHub(model);
  nodeById=new Map(model.nodes.map((node)=>[node.id,node]));
  hierarchyModel=createCorpusViews(model).hierarchy;
  graph=await createForceGraph3D({
    platform:createThreePlatform({THREE,TSL}),host:{mode:'managed',canvas:elements.canvas},
    renderer:{backend:parameters.get('backend')==='webgl2'?'webgl2':'auto',frameLoop:'demand',linkWidthUnit:'pixel',pixelRatio:{minimum:1,maximum:2},nodeSurface:{...metallicNodeSurface,emissive:.16,selectionEffect:{...metallicNodeSurface.selectionEffect,breathAmount:fullMotion?metallicNodeSurface.selectionEffect.breathAmount:0}},linkFlow:{enabled:false,direction:'source-to-target',speed:2.8,frequency:.18,pulseWidth:.1,intensity:1,color:0xaaf7ff,nodeReaction:{enabled:true,scale:1.85,intensity:.92,color:0xc9fbff}}},
    layout:{backend:'local',dimensions:3,autoStart:false,seed:20260831,minimumNodeDistance:3.5,separationStrength:.62,separationIterations:1,maxSeparationPairChecksPerStep:50000,linkDistance:24,linkStrength:.08,chargeStrength:-38,centerStrength:.008,velocityDecay:.46,alphaDecay:.018},
    nodes:{radius:(node)=>nodeRadius(node)*(nodeMotion?.scale(node.id)??1),color:nodeColor},links:{width:(link)=>link.data?.kind==='type' ? .38 : .62,color:(link)=>link.data?.kind==='type' ? 0x714968 : 0x334e69,opacity:.28},interaction:{hover:true,selection:'single',dragNodes:{enabled:true,releaseBehavior:'unpin'}}
  });
  reflowViewportLayout(false);
  graph.setData(hierarchyModel);
  graph.setStateTheme(coolStateTheme);
  nodeMotion=createNodeSpawnMotion({refreshNodeStyles:(ids)=>graph.refreshNodeStyles(ids),reducedMotion:()=>!fullMotion,onError:(error)=>{elements.status.textContent=error instanceof Error?error.message:String(error);}});
  positionMotion=createNodePositionMotion({setPosition:(id,position)=>graph.setNodeFixed(id,position),reducedMotion:()=>!fullMotion});
  cameraAnimator=createCameraAnimator({graph,canvas:elements.canvas,reducedMotion:()=>!fullMotion});
  graph.on('node-click',({nodeId})=>selectNode(nodeId,true));
  graph.on('node-drag',({phase})=>{cameraAnimator.cancel();setAutoFrame(false);if(phase==='end')graph.stopLayout();});
  graph.on('node-hover',({nodeId})=>{if(elements.canvas.dataset.building==='true'||elements.canvas.dataset.cameraFlight)return;const node=nodeById.get(nodeId);elements.status.textContent=node?node.data.label:`${manifest.fileCount} files · ${manifest.directoryCount} folders`;});
  graph.on('error',({error})=>{elements.status.textContent=error.message;elements.status.dataset.error='true';});
  bindControls();
  window.__forcegraphCorpusInspect=inspectCorpusView;
  elements.title.textContent=manifest.archive.replace(/\.zip$/i,'');
  elements.title.title=elements.title.textContent;
  elements.status.textContent=`${manifest.fileCount} files · ${manifest.directoryCount} folders · synthetic demo · metadata only`;
  updateMetrics();
  showOverview(false);
  await replayBuild();
  const diagnostics=graph.getDiagnostics();
  const representedPaths=new Set(hierarchyModel.nodes.map((node)=>node.data.path));
  const presentation=inspectCorpusPresentation();
  const assertions={allEntriesRepresented:manifest.records.every((record)=>representedPaths.has(record.path)),graphLoaded:diagnostics.nodeCount===hierarchyModel.nodes.length&&diagnostics.linkCount===hierarchyModel.links.length,batchedDraws:diagnostics.drawCalls<=2,typeOverlayAvailable:manifest.fileCount===0||model.nodes.length>hierarchyModel.nodes.length&&model.links.length>hierarchyModel.links.length,controlGroups:presentation.controlGroups===3,searchReachable:presentation.searchReachable,noHorizontalOverflow:presentation.noHorizontalOverflow,vectorRelayTheme:presentation.vectorRelayTheme,controlTargetFloor:presentation.minimumControlHeight>=44};
  window.__forcegraphCorpusProof={schema:'forcegraph_corpus_browser_v1',done:true,status:Object.values(assertions).every(Boolean)?'passed':'failed',manifest:{entries:manifest.entryCount,files:manifest.fileCount,directories:manifest.directoryCount},diagnostics,assertions};
}catch(error){reportRuntimeError(error);}

function bindControls(){
  populateMotionControls();
  listen(document.querySelector('[data-center]'),'change',(event)=>{
    overviewCenter=event.target.value;
    clearSearch();showOverview(true);
  });
  elements.motion.textContent=fullMotion?'Motion: full':'Motion: reduced';
  elements.canvas.tabIndex=0;
  elements.canvas.setAttribute('aria-description','Drag to orbit. Pinch to zoom. Arrow keys orbit, plus and minus zoom, Home fits the graph.');
  listen(document.querySelector('[data-auto-frame]'),'click',()=>{setAutoFrame(!autoFrame);if(autoFrame)refitCamera(true);});
  listen(document.querySelector('[data-zoom-in]'),'click',()=>zoomView(-230));
  listen(document.querySelector('[data-zoom-out]'),'click',()=>zoomView(230));
  listen(document.querySelector('[data-spread]'),'click',()=>{
    viewportSpread=!viewportSpread;
    document.querySelector('[data-spread]').setAttribute('aria-pressed',String(viewportSpread));
    clearSearch();showOverview(true);
  });
  listen(motionPreference,'change',()=>{if(!motionOverridden){fullMotion=motionPreference.matches;toggleMotion(false);}});
  resizeObserver=new ResizeObserver(()=>{if(resizeFrame!==undefined)cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{resizeFrame=undefined;if(!disposed&&autoFrame&&elements.canvas.dataset.building!=='true')refitCamera(false);});});
  resizeObserver.observe(elements.canvas);
  listen(elements.replay,'click',()=>{void replayBuild().catch(reportRuntimeError);});
  listen(elements.replayType,'change',()=>setReplayMode(elements.replayType.value));
  listen(elements.studio,'click',()=>toggleMotionStudio());
  listen(elements.studioClose,'click',()=>toggleMotionStudio(false));
  listen(elements.trail,'input',()=>{trailIntensity=Math.max(.2,Math.min(1,Number(elements.trail.value)/100));elements.trailValue.value=`${Math.round(trailIntensity*100)}%`;elements.status.textContent=`Trail intensity: ${Math.round(trailIntensity*100)}%`;});
  listen(elements.motion,'click',()=>toggleMotion());listen(elements.types,'click',toggleTypeOverlay);listen(elements.overview,'click',exitSearch);listen(elements.reset,'click',()=>{clearSearch();graph.setSelection([]);graph.setNodeFlagsMany(model.nodes.map((node)=>node.id),0,NodeFlags.Dimmed|NodeFlags.Focused);showOverview(true);});listen(elements.searchExit,'click',exitSearch);listen(elements.search,'keydown',(event)=>{if(event.key==='Escape'&&elements.search.value.trim()){event.preventDefault();exitSearch();}});listen(elements.search,'input',applySearch);listen(elements.searchAnimation,'change',()=>setSearchMode(elements.searchAnimation.value));
  listen(window,'keydown',(event)=>{if(event.defaultPrevented)return;if(event.key==='Escape'&&!elements.studioPanel.hidden){event.preventDefault();toggleMotionStudio(false);elements.studio.focus({preventScroll:true});}});
  bindCorpusNavigation({canvas:elements.canvas,graph,animator:cameraAnimator,listen,onManual:()=>setAutoFrame(false),onOverview:()=>{clearSearch();showOverview(true);}});
  listen(window,'pagehide',cleanup,{once:true});
}

function populateMotionControls(){
  populateSelect(elements.searchAnimation,searchMotionPresets,searchMode);
  populateSelect(elements.replayType,replayPresets,replayMode);
  populatePresetButtons(elements.scenePresets,motionScenes,'motionScene',applyMotionScene);
  populatePresetButtons(elements.searchCues,searchMotionPresets,'searchCue',setSearchMode,(preset)=>preset.family!=='classic');
  populatePresetButtons(elements.replayCues,replayPresets,'replayCue',setReplayMode,(preset)=>preset.family!=='classic');
  populatePresetButtons(elements.tempoPresets,tempoPresets,'tempo',setTempoMode);
  syncMotionControls();
}
function populateSelect(select,presets,value){select.replaceChildren();for(const preset of Object.values(presets)){const option=document.createElement('option');option.value=preset.id;option.textContent=preset.label;select.append(option);}select.value=value;}
function populatePresetButtons(container,presets,dataKey,onSelect,include=()=>true){container.replaceChildren();for(const preset of Object.values(presets)){if(!include(preset))continue;const button=document.createElement('button');button.type='button';button.textContent=preset.label;button.dataset[dataKey]=preset.id;listen(button,'click',()=>onSelect(preset.id));container.append(button);}}
function applyMotionScene(sceneId){const scene=motionScenes[sceneId];if(!scene)return;searchMode=scene.search;replayMode=scene.replay;syncMotionControls();elements.status.textContent=`${scene.label} selected · search and replay cues linked`;if(elements.search.value.trim())performSearch();}
function setSearchMode(value){searchMode=searchMotionPresets[value]?value:'signal-relay';syncMotionControls();if(elements.search.value.trim())performSearch();else elements.status.textContent=`Search cue: ${searchMotionPresets[searchMode].label}`;}
function setReplayMode(value){replayMode=replayPresets[value]?value:'weave';syncMotionControls();elements.status.textContent=`Next replay: ${replayPresets[replayMode].label}`;}
function setTempoMode(value){tempoMode=tempoPresets[value]?value:'standard';syncMotionControls();elements.status.textContent=`Motion tempo: ${tempoPresets[tempoMode].label}`;if(elements.search.value.trim())performSearch();}
function syncMotionControls(){
  elements.searchAnimation.value=searchMode;elements.replayType.value=replayMode;
  const activeScene=resolveMotionScene(searchMode,replayMode);for(const button of elements.scenePresets.querySelectorAll('button'))button.dataset.active=String(button.dataset.motionScene===activeScene);for(const button of elements.searchCues.querySelectorAll('button'))button.dataset.active=String(button.dataset.searchCue===searchMode);for(const button of elements.replayCues.querySelectorAll('button'))button.dataset.active=String(button.dataset.replayCue===replayMode);for(const button of elements.tempoPresets.querySelectorAll('button'))button.dataset.active=String(button.dataset.tempo===tempoMode);
  const scene=motionScenes[activeScene];elements.studioTitle.textContent=scene?.label??'Custom motion mix';elements.studioDescription.textContent=searchMode==='semantic-lens'?'A soft spatial wave reveals related clusters by distance.':searchMode==='evidence-walk'?'A directed evidence path advances one calm node arrival at a time.':'Sequential light travel with a single arrival bounce at each node.';
}
function toggleMotionStudio(force){const open=typeof force==='boolean'?force:elements.studioPanel.hidden;elements.studioPanel.hidden=!open;elements.studio.setAttribute('aria-expanded',String(open));elements.studio.dataset.active=String(open);if(open)elements.studioPanel.querySelector('button,select,input')?.focus({preventScroll:true});}
function scaledDuration(milliseconds){return fullMotion?durationForTempo(milliseconds,tempoMode):0;}

async function replayBuild(){
  const token=++replayToken;
  const view=typeOverlay?model:hierarchyModel;
  const preset=replayPresets[replayMode]??replayPresets.weave;
  const traced=Boolean(preset.trace);
  const spatial=preset.strategy!=='stream';
  const orderedNodes=[...view.nodes].sort((left,right)=>replayRank(left)-replayRank(right)||pathDepth(left)-pathDepth(right)||left.data.path.localeCompare(right.data.path));
  const parentByTarget=new Map(view.links.filter((link)=>link.data.kind==='hierarchy').map((link)=>[link.target,link.source]));
  const activeIds=new Set();
  const addedLinks=new Set();
  clearTimeout(searchTimer);searchTimer=undefined;searchMotionToken+=1;elements.search.value='';elements.searchResults.hidden=true;elements.searchExit.hidden=true;clearTransientEffects();delete elements.canvas.dataset.searchMotion;cameraAnimator.cancel();nodeMotion.cancelAll(false);positionMotion.cancelAll(false);setTraceStyle(traced,preset.trace);graph.setLinkFlow({enabled:traced&&fullMotion,direction:'source-to-target',speed:preset.trace==='director'?2.4:3.2,frequency:preset.trace==='ripple'?.22:.4,pulseWidth:preset.trace==='director'?.18:.32,intensity:.16+trailIntensity*.3,color:preset.trace==='director'?0xc7b4ff:0x6dd8e5,nodeReaction:{enabled:false}});setReplayControls(true);toggleMotionStudio(false);elements.canvas.dataset.replayMode=replayMode;elements.replay.textContent='Restart build';elements.ingestTitle.textContent=preset.title;delete elements.ingest.dataset.complete;elements.ingest.hidden=false;elements.ingestProgress.max=orderedNodes.length;elements.ingestProgress.value=0;elements.ingestLabel.textContent=`0% · 0 / ${manifest.entryCount} entries`;elements.status.textContent=preset.preparing;
  graph.setData(view);graph.setStateTheme(coolStateTheme);showOverview(false);graph.setData({nodes:[],links:[]});
  await delay(scaledDuration(140));
  const batchSize=!fullMotion?orderedNodes.length:Math.max(preset.batchMinimum,Math.ceil(orderedNodes.length/preset.batchDivisor));
  if(preset.cameraPath&&fullMotion){const from=graph.getCameraPose();if(from){const to=orbitCameraPose(from,preset.strategy==='score'?-120:-78,preset.strategy==='orbit'?-20:-10);cameraAnimator.animate(to,{durationMs:scaledDuration(Math.ceil(orderedNodes.length/batchSize)*preset.stepMs+preset.settleMs),easing:'smoothstep',path:cameraArcPath(from,to,preset.cameraPath),mode:`replay-${replayMode}`});}}
  for(let offset=0;offset<orderedNodes.length&&token===replayToken;offset+=batchSize){
    const batch=orderedNodes.slice(offset,offset+batchSize);
    for(const node of batch)activeIds.add(node.id);
    const links=view.links.filter((link)=>!addedLinks.has(link.id)&&activeIds.has(link.source)&&activeIds.has(link.target));
    for(const link of links)addedLinks.add(link.id);
    const planned=spatial?planReplayBatch(batch,parentByTarget,preset.strategy):undefined;
    const renderBatch=planned?.nodes??batch;
    graph.applyPatch({nodes:{upsert:renderBatch},links:{upsert:links}});graph.stopLayout();
    for(const [index,motion] of (planned?.motions??[]).entries()){const delayMs=scaledDuration(motion.delayMs);positionMotion.animate(motion.id,motion.from,motion.to,{durationMs:scaledDuration(preset.positionDurationMs),delayMs});if(traced&&fullMotion&&index===0){if(preset.trace==='ripple'){if((offset/batchSize)%9===0)spawnSearchRipple(motion.to,delayMs);}else spawnLightTrace(motion.from,motion.to,delayMs,preset.trace);}}
    batch.forEach((node,index)=>nodeMotion.animate(node.id,{from:preset.nodeFrom,durationMs:scaledDuration(preset.nodeDurationMs),delayMs:scaledDuration(index*preset.nodeDelayMs),overshoot:preset.nodeOvershoot}));
    updateReplayProgress(Math.min(orderedNodes.length,offset+batch.length),orderedNodes.length,addedLinks.size);
    await delay(scaledDuration(preset.stepMs));
  }
  if(token!==replayToken)return;
  await delay(Math.max(20,scaledDuration(preset.settleMs)));
  if(token!==replayToken)return;
  cameraAnimator.cancel();graph.setLinkFlow({enabled:false});setTraceStyle(false);clearTransientEffects();delete elements.canvas.dataset.replayMode;graph.stopLayout();positionMotion.cancelAll(true);for(const node of orderedNodes)graph.releaseNode(node.id);graph.stopLayout();nodeMotion.cancelAll(true);elements.ingest.dataset.complete='true';elements.ingestLabel.textContent=`100% · ${manifest.entryCount} entries ready`;elements.status.textContent=`Corpus ready · ${manifest.fileCount} files · ${manifest.directoryCount} folders`;elements.replay.textContent='Replay build';updateMetrics();setReplayControls(false);if(autoFrame)showOverview(true);
  await delay(Math.max(50,scaledDuration(900)));
  if(token===replayToken)elements.ingest.hidden=true;
}
function updateReplayProgress(loaded,total,linksLoaded){const percent=Math.round(loaded/Math.max(1,total)*100);const entries=Math.min(manifest.entryCount,Math.max(0,loaded-1));elements.ingestProgress.value=loaded;elements.ingestLabel.textContent=`${percent}% · ${entries} / ${manifest.entryCount} entries`;elements.status.textContent=`${replayPresets[replayMode]?.running??'Building corpus…'} ${entries} nodes`;elements.metrics.textContent=`${loaded} nodes · ${linksLoaded} relationships · ${percent}% mapped · 2 batched draws`;}
function setTraceStyle(enabled,variant='signal'){const activeColor=variant==='director'?0x76649d:variant==='ripple'?0x32647c:0x416a82;graph.setLinkStyle({width:enabled ? .86 : (link)=>link.data?.kind==='type' ? .38 : .62,color:(link)=>link.data?.kind==='type' ? 0x714968 : enabled ? activeColor : 0x334e69,opacity:enabled ? .28+trailIntensity*.2 : .28});}
function spawnLightTrace(from,to,delayMs,variant='signal'){const camera=graph.getCameraPose();if(!camera)return;const start=projectWorldPoint(from,camera),end=projectWorldPoint(to,camera);if(!start||!end)return;const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy);if(length<4)return;const streakWidth=Math.min(variant==='director'?92:68,Math.max(20,length*(variant==='director'?.32:.24)));const streak=document.createElement('i');streak.className=`light-streak ${variant}`;streak.style.left=`${start.x}px`;streak.style.top=`${start.y}px`;streak.style.width=`${streakWidth}px`;streak.style.setProperty('--trace-angle',`${Math.atan2(dy,dx)}rad`);streak.style.setProperty('--trace-travel',`${Math.max(0,length-streakWidth)}px`);streak.style.setProperty('--trace-delay',`${delayMs}ms`);streak.style.setProperty('--trace-alpha',String(.25+trailIntensity*.72));elements.traceLayer.append(streak);scheduleTransient(()=>streak.remove(),delayMs+scaledDuration(variant==='director'?1700:900));}
function spawnSearchRipple(point,delayMs=0){const camera=graph.getCameraPose(),center=camera&&projectWorldPoint(point,camera);if(!center)return;for(let index=0;index<2;index+=1){const ripple=document.createElement('i');ripple.className='search-ripple';ripple.style.left=`${center.x}px`;ripple.style.top=`${center.y}px`;ripple.style.setProperty('--ripple-delay',`${delayMs+scaledDuration(index*180)}ms`);ripple.style.setProperty('--ripple-alpha',String(.16+trailIntensity*.3));elements.traceLayer.append(ripple);scheduleTransient(()=>ripple.remove(),delayMs+scaledDuration(1500+index*180));}}
function scheduleTransient(callback,milliseconds){const timer=setTimeout(()=>{transientTimers.delete(timer);if(!disposed)callback();},Math.max(0,milliseconds));transientTimers.add(timer);return timer;}
function clearTransientEffects(){for(const timer of transientTimers)clearTimeout(timer);transientTimers.clear();elements.traceLayer?.replaceChildren();}
function projectWorldPoint(point,camera){const forward=normalizeVector(subtractVector(camera.target,camera.position));let right=normalizeVector(crossVector(forward,{x:0,y:1,z:0}));if(Math.hypot(right.x,right.y,right.z)<.001)right={x:1,y:0,z:0};const up=normalizeVector(crossVector(right,forward));const relative=subtractVector(point,camera.position),depth=dotVector(relative,forward);if(depth<=.01)return undefined;const scale=1/Math.tan(50*Math.PI/360),aspect=elements.canvas.clientWidth/Math.max(1,elements.canvas.clientHeight);const ndcX=dotVector(relative,right)*scale/(depth*aspect),ndcY=dotVector(relative,up)*scale/depth;return{x:(ndcX*.5+.5)*elements.canvas.clientWidth,y:(.5-ndcY*.5)*elements.canvas.clientHeight};}
function subtractVector(left,right){return{x:left.x-right.x,y:left.y-right.y,z:left.z-right.z};}
function crossVector(left,right){return{x:left.y*right.z-left.z*right.y,y:left.z*right.x-left.x*right.z,z:left.x*right.y-left.y*right.x};}
function dotVector(left,right){return left.x*right.x+left.y*right.y+left.z*right.z;}
function normalizeVector(value){const length=Math.hypot(value.x,value.y,value.z);return length>.0001?{x:value.x/length,y:value.y/length,z:value.z/length}:{x:0,y:0,z:0};}
function planReplayBatch(batch,parentByTarget,strategy){const planned=new Map();const motions=[];const nodes=batch.map((node,index)=>{const target=node.initialPosition??{x:0,y:0,z:0};let initialPosition;if(node.data.kind==='root')initialPosition={x:0,y:0,z:0};else if(strategy==='orbit'){const angle=(hashDirection(node.id)%6283)/1000,radius=12+pathDepth(node)*3.4;initialPosition={x:target.x+Math.cos(angle)*radius,y:target.y+Math.sin(angle)*radius*.7,z:target.z+Math.sin(angle*1.7)*radius};}else if(strategy==='score'){const phase=(hashDirection(node.id)%6283)/1000,offset=24+pathDepth(node)*4;initialPosition={x:target.x-offset,y:target.y+Math.sin(phase)*9,z:target.z+Math.cos(phase)*7};}else{const parentId=parentByTarget.get(node.id)??'corpus:root';const parentPosition=graph.getNodePosition(parentId)??planned.get(parentId)??{x:0,y:0,z:0};initialPosition=parentRelativePosition(parentPosition,parentId,node.id,{distance:node.data.kind==='folder'?4.6:2.8,seed:20260831});}planned.set(node.id,initialPosition);motions.push({id:node.id,from:initialPosition,to:target,delayMs:index*12});return{...node,initialPosition};});return{nodes,motions};}
function setReplayControls(running){for(const control of [elements.replayType,elements.studio,elements.trail,elements.types,elements.overview,elements.reset,elements.search,elements.searchAnimation,elements.searchExit,document.querySelector('[data-spread]'),document.querySelector('[data-center]')])control.disabled=running;for(const button of [...elements.scenePresets.querySelectorAll('button'),...elements.searchCues.querySelectorAll('button'),...elements.replayCues.querySelectorAll('button'),...elements.tempoPresets.querySelectorAll('button')])button.disabled=running;elements.canvas.dataset.building=String(running);}
function replayRank(node){return node.data.kind==='root'?0:node.data.kind==='folder'?1:node.data.kind==='type'?3:2;}
function pathDepth(node){return node.data.path.split('/').filter(Boolean).length;}
function delay(milliseconds){return new Promise((resolve)=>setTimeout(resolve,milliseconds));}
function toggleMotion(manual=true){motionOverridden||=manual;fullMotion=!fullMotion;cameraAnimator.cancel();cancelSearchMotion();graph.setNodeSurface({selectionEffect:{breathAmount:fullMotion?metallicNodeSurface.selectionEffect.breathAmount:0}});if(!fullMotion){positionMotion.cancelAll(true);graph.setLinkFlow({enabled:false});}elements.motion.textContent=fullMotion?'Motion: full':'Motion: reduced';elements.motion.dataset.active=String(fullMotion);elements.status.textContent=fullMotion?'Cinematic camera motion enabled':'Reduced camera motion enabled';if(elements.search.value.trim())performSearch();else if(autoFrame)refitCamera(false);}
function toggleTypeOverlay(){typeOverlay=!typeOverlay;graph.setData(typeOverlay?model:hierarchyModel);graph.setStateTheme(coolStateTheme);elements.types.textContent=typeOverlay?'Hide type overlay':'Show type overlay';elements.types.dataset.active=String(typeOverlay);updateMetrics();if(viewRefreshFrame!==undefined)cancelAnimationFrame(viewRefreshFrame);viewRefreshFrame=requestAnimationFrame(()=>{viewRefreshFrame=undefined;if(disposed||!graph||graph.isDisposed)return;elements.search.value.trim()?performSearch():showOverview(true);});}
function updateMetrics(){const view=typeOverlay?model:hierarchyModel;elements.metrics.textContent=`${view.nodes.length} nodes · ${view.links.length} relationships · ${formatBytes(manifest.totalBytes)} uncompressed · 2 batched draws`;}
function applySearch(){clearTimeout(searchTimer);cancelSearchMotion();elements.status.textContent=elements.search.value.trim()?'Searching corpus…':`${manifest.fileCount} files · ${manifest.directoryCount} folders`;searchTimer=setTimeout(()=>{searchTimer=undefined;performSearch();},150);}
function clearSearch(){clearTimeout(searchTimer);searchTimer=undefined;cancelSearchMotion();graph?.setStateTheme(coolStateTheme);elements.search.value='';elements.searchResults.hidden=true;elements.searchExit.hidden=true;}
function exitSearch(){clearSearch();showOverview(true);elements.search.focus({preventScroll:true});}
function performSearch(){cancelSearchMotion();cameraAnimator.cancel();const query=elements.search.value.trim().toLowerCase();const view=typeOverlay?model:hierarchyModel;graph.setNodeFlagsMany(model.nodes.map((node)=>node.id),0,NodeFlags.Dimmed|NodeFlags.Focused);if(!query){graph.setStateTheme(coolStateTheme);elements.searchExit.hidden=true;elements.searchResults.hidden=true;showOverview(true);return;}elements.searchExit.hidden=false;graph.setStateTheme(searchStateTheme);const matches=view.nodes.filter((node)=>`${node.data.label} ${node.data.path} ${node.data.extension??''}`.toLowerCase().includes(query));const matchedIds=new Set(matches.map((node)=>node.id));for(const node of view.nodes)graph.setNodeFlags(node.id,matchedIds.has(node.id)?NodeFlags.Focused:NodeFlags.Dimmed,NodeFlags.Dimmed|NodeFlags.Focused);renderSearchResults(matches);if(matches.length===0){elements.status.textContent='No matching nodes';return;}if(matches.length===1)selectNode(matches[0].id,true,'search');void runSearchMotion(matches).catch(reportRuntimeError);}
function renderSearchResults(matches){elements.searchResults.replaceChildren();elements.searchResults.hidden=false;if(matches.length===0){const empty=document.createElement('p');empty.textContent='No matching files or folders';elements.searchResults.append(empty);return;}for(const node of matches.slice(0,8)){const button=document.createElement('button');button.type='button';const label=document.createElement('strong');label.textContent=node.data.label;const path=document.createElement('span');path.textContent=node.data.path||node.data.kind;button.append(label,path);button.addEventListener('click',()=>{cancelSearchMotion();selectNode(node.id,true,'search');});elements.searchResults.append(button);}}
async function runSearchMotion(matches){
  const preset=searchMotionPresets[searchMode]??searchMotionPresets['signal-relay'];
  const token=++searchMotionToken;
  const candidates=preset.effect==='walk'?orderSearchWalk(matches):matches;
  const animated=candidates.slice(0,preset.limit||matches.length);
  elements.canvas.dataset.searchMotion=searchMode;elements.status.textContent=`${preset.label} · ${matches.length} matched node${matches.length===1?'':'s'}`;
  if(matches.length>1)frameSearchResults(matches,preset);
  if(!fullMotion||preset.effect==='instant'){finishSearchMotion(token,matches.length);return;}
  if(preset.effect==='lens'){
    const positioned=animated.map((node)=>({node,position:graph.getNodePosition(node.id)})).filter((entry)=>entry.position);const anchor=positioned[0];if(anchor){graph.setSelection([anchor.node.id]);spawnSearchRipple(anchor.position);positioned.sort((left,right)=>distance3(left.position,anchor.position)-distance3(right.position,anchor.position));positioned.forEach(({node},index)=>nodeMotion.pulse(node.id,{peak:preset.peak,durationMs:scaledDuration(preset.durationMs),delayMs:scaledDuration(index*preset.staggerMs)}));await delay(scaledDuration(preset.durationMs+positioned.length*preset.staggerMs));}
  }else if(preset.intervalMs===0){animated.forEach((node,index)=>nodeMotion.pulse(node.id,{peak:preset.peak,durationMs:scaledDuration(preset.durationMs),delayMs:scaledDuration(index*preset.staggerMs)}));await delay(scaledDuration(preset.durationMs+animated.length*preset.staggerMs));}
  else{let previousPosition;for(let index=0;index<animated.length&&token===searchMotionToken;index+=1){const node=animated[index],position=graph.getNodePosition(node.id);graph.setSelection([node.id]);nodeMotion.pulse(node.id,{peak:preset.peak,durationMs:scaledDuration(preset.durationMs)});if(preset.trace&&previousPosition&&position)spawnLightTrace(previousPosition,position,0,preset.trace);previousPosition=position;elements.status.textContent=`${preset.label} · ${index+1} / ${animated.length} · ${node.data.label}`;await delay(scaledDuration(preset.intervalMs));}}
  finishSearchMotion(token,matches.length);
}
function finishSearchMotion(token,matchCount){if(token!==searchMotionToken)return;delete elements.canvas.dataset.searchMotion;elements.status.textContent=`${matchCount} matching node${matchCount===1?'':'s'} · ${searchMotionPresets[searchMode].label}`;}
function cancelSearchMotion(settle=true){searchMotionToken+=1;delete elements.canvas.dataset.searchMotion;clearTransientEffects();nodeMotion?.cancelAll(settle);}
function orderSearchWalk(matches){return [...matches].sort((left,right)=>pathDepth(left)-pathDepth(right)||left.data.path.localeCompare(right.data.path));}
function distance3(left,right){return Math.hypot(left.x-right.x,left.y-right.y,left.z-right.z);}
function frameSearchResults(matches,preset=searchMotionPresets['signal-relay']){
  frameNodes=matches;frameRadiusScale=2.2;setAutoFrame(true);
  const from=graph.getCameraPose(),to=currentFrame();
  if(!from||!to)return;
  cameraAnimator.animate(to,{durationMs:scaledDuration(preset.cameraDurationMs),easing:'cubic-in-out',path:cameraArcPath(from,to,preset.cameraPath),mode:`search-${searchMode}`});
}
function selectNode(nodeId,focus,source='graph'){
  const node=nodeById.get(nodeId);if(!node)return;
  const fromSearch=source==='search';
  graph.setSelection([nodeId]);
  elements.selectedTitle.textContent=node.data.label;elements.selectedTitle.title=node.data.label;
  elements.selectedPath.textContent=node.data.path;elements.selectedPath.title=node.data.path;
  elements.selectedDetail.textContent=['file','document','image','data'].includes(node.data.kind)?`${node.data.kind} · ${node.data.extension} · ${formatBytes(node.data.size)}`:`${node.data.kind} node`;
  if(fromSearch)elements.searchResults.hidden=true;
  elements.searchExit.hidden=false;
  if(!focus)return;
  const from=graph.getCameraPose();if(!from)return;
  graph.setNodeFlagsMany(model.nodes.filter((candidate)=>candidate.id!==nodeId).map((candidate)=>candidate.id),NodeFlags.Dimmed,NodeFlags.Focused);
  graph.setNodeFlags(nodeId,NodeFlags.Focused,NodeFlags.Dimmed);
  frameNodes=[node];frameRadiusScale=4.5;setAutoFrame(true);
  const to=currentFrame();if(!to)return;
  cameraAnimator.cancel();
  const path=fromSearch?'arc-over':hashDirection(nodeId)%2===0?'arc-left':'arc-right';
  elements.status.textContent=`Flying to ${node.data.label}…`;
  const movement=cameraAnimator.animate(to,{durationMs:fromSearch?1100:1450,easing:'cubic-in-out',path:cameraArcPath(from,to,path),mode:fromSearch?'search-focus':'cinematic',onComplete:()=>{elements.status.textContent=`Focused ${node.data.label} · Back to overview to exit`;}});
  if(movement==='instant')elements.status.textContent=`Focused ${node.data.label} · reduced motion`;
}
function showOverview(animate=true){
  frameNodes=undefined;frameRadiusScale=1.2;setAutoFrame(true);
  graph.setSelection([]);
  graph.setNodeFlagsMany(model.nodes.map((node)=>node.id),0,NodeFlags.Dimmed|NodeFlags.Focused);
  elements.selectedTitle.textContent='Full corpus';elements.selectedTitle.title='';
  elements.selectedPath.textContent='';elements.selectedPath.title='';
  elements.selectedDetail.textContent=manifest.entryCount?'Every archive entry is represented without extracting file contents.':'This archive is empty. Only its root node is shown.';
  elements.searchExit.hidden=true;
  refitCamera(animate);
}
function currentFrame(){
  const pose=graph.getCameraPose();
  const view=frameNodes??(typeOverlay?model:hierarchyModel).nodes;
  const points=corpusFramePoints(view,(id)=>graph.getNodePosition(id),(node)=>nodeRadius(node)*frameRadiusScale);
  const width=elements.canvas.clientWidth,height=elements.canvas.clientHeight;
  const stage=elements.canvas.getBoundingClientRect();
  const dock=document.querySelector('.search-dock').getBoundingClientRect();
  const controls=document.querySelector('.view-controls').getBoundingClientRect();
  let bottom=stage.bottom-dock.top+10;
  if(!elements.searchResults.hidden)bottom=Math.min(height*.35,stage.bottom-elements.searchResults.getBoundingClientRect().top+10);
  let top=controls.bottom-stage.top+8;
  const hubOverview=!frameNodes&&overviewCenter==='hub';
  if(hubOverview)top=bottom=Math.max(top,bottom);
  const anchorId=overviewCenter==='hub'?mainHubId:'corpus:root';
  const direction=pose?subtractVector(pose.position,pose.target):{x:.35,y:.2,z:1};
  return planCorpusFrame(points,{width,height,direction,insets:{left:12,right:12,top,bottom},minimumDistance:frameNodes?.length===1?12:8,anchor:frameNodes||overviewCenter==='graph'?undefined:graph.getNodePosition(anchorId)});
}
function refitCamera(animate=false){
  if(!frameNodes&&autoFrame&&elements.canvas.dataset.building!=='true')reflowViewportLayout();
  const to=currentFrame(),from=graph.getCameraPose();
  if(!to||!from||disposed)return;
  cameraAnimator.cancel();
  if(!animate||!fullMotion){graph.setCameraPose(to);return;}
  cameraAnimator.animate(to,{durationMs:900,easing:'cubic-in-out',path:{type:'direct'},mode:'overview'});
}
function reflowViewportLayout(commit=true){
  const width=elements.canvas.clientWidth,height=elements.canvas.clientHeight;
  if(!(width>0&&height>0)||!naturalModel)return;
  const stage=elements.canvas.getBoundingClientRect();
  const top=document.querySelector('.view-controls').getBoundingClientRect().bottom-stage.top+8;
  const bottom=stage.bottom-document.querySelector('.search-dock').getBoundingClientRect().top+10;
  const usableWidth=width-24,usableHeight=Math.max(48,height-top-bottom);
  const key=`${(usableWidth/usableHeight).toFixed(3)}:${viewportSpread}:${typeOverlay}`;
  if(key===viewportLayoutKey)return;
  viewportLayoutKey=key;
  const pose=graph.getCameraPose();
  const direction=pose?subtractVector(pose.position,pose.target):{x:0,y:0,z:1};
  const visible=naturalModel.nodes.filter(node=>typeOverlay||node.data.kind!=='type');
  const points=visible.map(node=>({id:node.id,group:node.data.layoutGroup??node.id,position:node.initialPosition,radius:nodeRadius(node)}));
  const positions=new Map((viewportSpread?spreadCorpusPositions(points,{width:usableWidth,height:usableHeight,direction}):points).map(point=>[point.id,point.position]));
  model={nodes:naturalModel.nodes.map(node=>({...node,initialPosition:positions.get(node.id)??node.initialPosition})),links:naturalModel.links};
  hierarchyModel=createCorpusViews(model).hierarchy;
  nodeById=new Map(model.nodes.map(node=>[node.id,node]));
  if(commit){
    for(const node of model.nodes){
      if(!graph.getNodePosition(node.id))continue;
      graph.setNodeFixed(node.id,node.initialPosition);graph.releaseNode(node.id);
    }
    graph.stopLayout();
  }
}
function setAutoFrame(enabled){
  autoFrame=enabled;
  const control=document.querySelector('[data-auto-frame]');
  control.setAttribute('aria-pressed',String(enabled));control.dataset.active=String(enabled);
  control.title=enabled?'Fits the current view when the canvas changes size':'Manual view. Enable to fit the graph again.';
}
function zoomView(delta){
  const from=graph.getCameraPose();if(!from)return;
  setAutoFrame(false);cameraAnimator.cancel();
  cameraAnimator.animate(zoomCameraPose(from,delta),{durationMs:320,easing:'cubic-in-out',mode:'zoom'});
}
function inspectCorpusView(){
  const pose=graph.getCameraPose();
  const nodes=(typeOverlay?model:hierarchyModel).nodes;
  return {autoFrame,fullMotion,overviewCenter,mainHubId,building:elements.canvas.dataset.building==='true',flight:elements.canvas.dataset.cameraFlight??null,pose,diagnostics:graph.getDiagnostics(),width:elements.canvas.clientWidth,height:elements.canvas.clientHeight,pixelRatio:elements.canvas.width/Math.max(1,elements.canvas.clientWidth),layout:inspectCorpusPresentation(),points:nodes.map((node)=>{const position=graph.getNodePosition(node.id);return position?{id:node.id,...projectWorldPoint(position,pose),radius:nodeRadius(node),projectedRadius:projectWorldRadius(position,nodeRadius(node),pose)}:null;}).filter(Boolean)};
}
function inspectCorpusPresentation(){
  const searchDock=document.querySelector('.search-dock');
  const canvasRect=elements.canvas?.getBoundingClientRect();
  const visibleControls=[...document.querySelectorAll('button,input,select,summary')].filter((control)=>control.getClientRects().length>0).map((control)=>control.getBoundingClientRect().height);
  const themeStyle=getComputedStyle(document.body);
  return {controlGroups:document.querySelectorAll('[data-control-group]').length,searchReachable:Boolean(searchDock&&!searchDock.hidden&&elements.search?.getBoundingClientRect().width>0),noHorizontalOverflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1,sceneReachable:Boolean(canvasRect&&canvasRect.width>0&&canvasRect.height>0),studioDisclosure:elements.studio instanceof HTMLButtonElement,vectorRelayTheme:document.body.dataset.uiTheme==='vector-relay'&&themeStyle.getPropertyValue('--vr-teal').trim()==='#55e6d4',minimumControlHeight:visibleControls.length>0?Math.min(...visibleControls):0};
}
function projectWorldRadius(point,radius,camera){
  const forward=normalizeVector(subtractVector(camera.target,camera.position));
  const depth=dotVector(subtractVector(point,camera.position),forward);
  return depth>0?radius*(1/Math.tan(50*Math.PI/360))*elements.canvas.clientHeight/(2*depth):0;
}
function nodeRadius(node){if(node.data?.kind==='root')return 5.5;if(node.data?.kind==='type')return 3.2;if(node.data?.kind==='folder')return 2.8;return 1.4+Math.min(.95,Math.log10(1+(node.data?.size??0))*.18);}
function nodeColor(node){return({root:0xf3f7ff,folder:0xe4b75f,document:0x6edcf4,image:0xbb86fc,data:0x65d79d,type:0xff7f9d,file:0x7891ae})[node.data?.kind]??0x7891ae;}
function formatBytes(value){if(value<1024)return`${value} B`;if(value<1048576)return`${(value/1024).toFixed(1)} KiB`;return`${(value/1048576).toFixed(1)} MiB`;}
function hashDirection(value){let hash=0;for(let index=0;index<value.length;index+=1)hash=(Math.imul(hash,31)+value.charCodeAt(index))|0;return Math.abs(hash);}
function listen(target,type,listener,options){target.addEventListener(type,listener,options);removers.push(()=>target.removeEventListener(type,listener,options));}
function reportRuntimeError(error){const message=error instanceof Error?error.message:String(error);elements.status.textContent=message;elements.status.dataset.error='true';try{graph?.setLinkFlow({enabled:false});}catch{}if(model)setReplayControls(false);window.__forcegraphCorpusProof={schema:'forcegraph_corpus_browser_v1',done:true,status:'failed',error:message};}
function cleanup(){if(disposed)return;disposed=true;replayToken+=1;searchMotionToken+=1;clearTimeout(searchTimer);searchTimer=undefined;if(viewRefreshFrame!==undefined)cancelAnimationFrame(viewRefreshFrame);viewRefreshFrame=undefined;if(resizeFrame!==undefined)cancelAnimationFrame(resizeFrame);resizeObserver?.disconnect();clearTransientEffects();cameraAnimator?.dispose();nodeMotion?.dispose();positionMotion?.dispose();for(const remove of removers.splice(0))remove();delete window.__forcegraphCorpusInspect;graph?.dispose();}
