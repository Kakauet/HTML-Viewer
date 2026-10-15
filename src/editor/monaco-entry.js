// Bundle upstream ESM into a local classic script so file:// keeps working too.
import * as monaco from 'monaco-editor';

const base = new URL('.', document.currentScript.src);
globalThis.MonacoEnvironment = {
  getWorker(_id, label) {
    const name = label === 'json' ? 'json' : ['css', 'scss', 'less'].includes(label) ? 'css'
      : ['html', 'handlebars', 'razor'].includes(label) ? 'html'
      : ['typescript', 'javascript'].includes(label) ? 'ts' : 'editor';
    const url = new URL(`${name}.worker.js`, base);
    if (base.protocol !== 'file:') return new Worker(url);
    return new Promise((resolve, reject) => {
      const create = () => {
        const source = globalThis.__htmlViewerWorkerSources[name];
        const blobUrl = URL.createObjectURL(new Blob([`(${source})();`], { type: 'text/javascript' }));
        const worker = new Worker(blobUrl);
        URL.revokeObjectURL(blobUrl);
        resolve(worker);
      };
      if (globalThis.__htmlViewerWorkerSources?.[name]) { create(); return; }
      const script = document.createElement('script');
      script.src = url.href;
      script.onload = () => { script.remove(); create(); };
      script.onerror = () => { script.remove(); reject(new Error(`Worker source unavailable: ${name}`)); };
      document.head.appendChild(script);
    });
  }
};
globalThis.monaco = monaco;
