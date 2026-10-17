for (const [selector, compatibility] of [['[data-compatibility]', true], ['[data-automatic]', false]]) {
  const url = new URL(location.href);
  url.searchParams.delete('fallback');
  if (compatibility) url.searchParams.set('backend', 'canvas2d');
  else url.searchParams.delete('backend');
  document.querySelector(selector).href = url.href;
}
import('./search-scan.js').catch((error) => {
  document.body.dataset.presentation = 'false';
  const status = document.querySelector('[data-status]');
  status.dataset.error = 'true';
  status.textContent = 'The demo could not load. Reload this page to retry. ' + (error?.message ?? String(error));
  document.querySelector('[data-counts]').textContent = 'Demo unavailable';
  for (const control of document.querySelectorAll('.scan-controls button, .scan-controls input, .scan-controls select, .scan-search button, .scan-search input')) control.disabled = true;
  console.error('Search scan could not load:', error);
});
