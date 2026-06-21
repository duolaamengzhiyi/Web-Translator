import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { renderPdf } from '@/lib/pdf/viewer';

/** PDF 翻译查看器：从 ?file= 参数加载远程 PDF，或本地选择文件。 */
export const App = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState('');
  const fileParam = new URLSearchParams(window.location.search).get('file');

  useEffect(() => {
    if (fileParam && containerRef.current && !startedRef.current) {
      startedRef.current = true;
      renderPdf(containerRef.current, fileParam, setStatus).catch((error: unknown) => {
        setStatus(`出错：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, [fileParam]);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !containerRef.current) return;
    startedRef.current = true;
    containerRef.current.innerHTML = '';
    setStatus('正在读取文件…');
    const buffer = await file.arrayBuffer();
    renderPdf(containerRef.current, buffer, setStatus).catch((error: unknown) => {
      setStatus(`出错：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return (
    <div className="wt-pdf-app">
      <header className="wt-pdf-header">
        <span className="wt-logo">译</span>
        <strong>PDF 翻译查看器</strong>
        {!fileParam && (
          <input type="file" accept="application/pdf" onChange={onFile} className="wt-pdf-file" />
        )}
        <span className="wt-pdf-status">{status}</span>
      </header>
      <div ref={containerRef} className="wt-pdf-container" />
    </div>
  );
};
