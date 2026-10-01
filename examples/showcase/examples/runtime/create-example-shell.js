export function createExampleShell(options) {
  const { root, config, kind, examples } = options;
  const showcaseBase = new URL('../../', import.meta.url).pathname;
  const examplePath = (slug) => `${showcaseBase}examples/${slug}/index.html`;
  document.body.dataset.uiTheme = 'vector-relay';
  root.innerHTML = `
    <div class="observatory">
      <aside class="example-rail" aria-label="Showcase examples">
        <a class="rail-home" href="${showcaseBase}index.html" aria-label="ForceGraph TSL showcase"><span>FG</span><span>TSL</span></a>
        <p class="rail-heading">Examples</p>
        <nav class="rail-links">${examples.map((item) => `
          <a href="${examplePath(item.slug)}" ${item.slug === kind ? 'aria-current="page"' : ''}>
            <span class="rail-index">${item.index}</span><span>${item.label}</span>
          </a>`).join('')}</nav>
      </aside>

      <header class="telemetry" aria-label="Renderer status">
        <output class="telemetry-chip" data-metric="backend">Starting</output>
        <output class="telemetry-chip" data-metric="fps">-- FPS</output>
        <output class="telemetry-chip telemetry-detail" data-metric="draws">-- draws</output>
      </header>

      <section class="graph-stage" aria-label="${config.title} graph">
        <canvas id="graph" tabindex="0" aria-label="Interactive three-dimensional force graph. Drag empty space to rotate, use the mouse wheel to zoom, and select a node to inspect it."></canvas>
        <output id="runtime-status" class="stage-status" data-state="loading" aria-live="polite">Starting renderer</output>
      </section>

      <aside class="node-inspector" data-open="false" aria-label="Selected node inspector">
        <header class="inspector-header"><div><p class="inspector-kicker">${config.flowControls ? 'Directional link flow' : config.cameraControls ? 'Camera tween' : 'Selected node'}</p><h1 data-inspector="label">${config.flowControls ? 'Source → target' : 'No selection'}</h1></div><button type="button" class="text-button" data-action="close-inspector">Close</button></header>
        ${options.inspectorContent}
        <dl class="inspector-facts">
          <div><dt>Surface</dt><dd data-inspector="surface">metallic</dd></div>
          <div><dt>GPU</dt><dd>shared</dd></div>
          <div><dt>Transform</dt><dd data-inspector="transform">pending</dd></div>
        </dl>
      </aside>

      <footer class="interaction-bar" aria-label="Graph controls">
        <span class="gesture-hint"><strong>Drag</strong> Rotate</span>
        <span class="gesture-hint"><strong>Wheel</strong> Zoom</span>
        <span class="gesture-hint"><strong>Shift drag</strong> Pan</span>
        <button type="button" data-action="reset"><kbd>R</kbd> Reset</button>
        <button type="button" data-action="focus"><kbd>F</kbd> Focus</button>
        ${config.actions.map((action) => `<button type="button" data-action="${action}">${options.actionLabel(action)}</button>`).join('')}
        <button type="button" data-action="effects" data-active="true" aria-pressed="true">HAIO effects on</button>
        <label class="motion-control"><span>Reduced motion</span><input type="checkbox" data-control="reduced-motion" ${options.reducedMotion ? 'checked' : ''}></label>
      </footer>
    </div>`;
}
