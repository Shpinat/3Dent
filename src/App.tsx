import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { readDicomFile, type ReadProgress } from './dicom/readDicomFile';
import type { ParsedDicomVolume } from './dicom/types';

const MprViewer = lazy(() =>
  import('./components/MprViewer').then((module) => ({ default: module.MprViewer })),
);

interface LoadingState {
  message: string;
  progress: number;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [volume, setVolume] = useState<ParsedDicomVolume | null>(null);
  const [loading, setLoading] = useState<LoadingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleProgress = useCallback((progress: ReadProgress) => {
    if (progress.stage === 'parsing') {
      setLoading({ message: 'Проверка DICOM и декодирование кадров…', progress: 90 });
      return;
    }
    const percentage = progress.total > 0
      ? Math.min(88, Math.round((progress.loaded / progress.total) * 88))
      : 0;
    setLoading({ message: 'Чтение файла с диска…', progress: percentage });
  }, []);

  const loadFile = useCallback(async (file?: File) => {
    if (!file) return;
    setVolume(null);
    setError(null);
    setLoading({ message: 'Подготовка чтения…', progress: 0 });
    try {
      const parsedVolume = await readDicomFile(file, handleProgress);
      setVolume(parsedVolume);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить файл.');
      setLoading(null);
    }
  }, [handleProgress]);

  const handleReady = useCallback(() => setLoading(null), []);
  const handleViewerStatus = useCallback((message: string, progress: number) => {
    setLoading({ message, progress });
  }, []);
  const handleViewerError = useCallback((message: string) => {
    setError(message);
    setLoading(null);
    setVolume(null);
  }, []);

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="brand-overline">DENTAL IMAGING</p>
            <h1>3Dent <span>·</span> MPR</h1>
          </div>
        </div>
        <div className="header-status">
          <span className={`status-indicator${volume ? ' status-indicator--ready' : ''}`} />
          {volume ? 'Локальный просмотр' : 'Ожидание файла'}
        </div>
      </header>

      <section
        className={`workspace${dragging ? ' workspace--dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        {volume ? (
          <>
            <div className="study-bar">
              <div className="study-title">
                <span className="study-icon" aria-hidden="true">▦</span>
                <div>
                  <p className="eyebrow">ТЕКУЩЕЕ ИССЛЕДОВАНИЕ</p>
                  <strong title={volume.sourceName}>{volume.sourceName}</strong>
                </div>
              </div>
              <div className="study-meta">
                <span>{volume.modality}</span>
                <span>{volume.dimensions[0]} × {volume.dimensions[1]} × {volume.numberOfFrames}</span>
                <span>{volume.spacing[0].toFixed(2)} × {volume.spacing[1].toFixed(2)} × {volume.spacing[2].toFixed(2)} mm</span>
              </div>
              <button className="change-file-button" onClick={() => inputRef.current?.click()}>
                Открыть файл
              </button>
            </div>
            <Suspense fallback={null}>
              <MprViewer
                volume={volume}
                onStatus={handleViewerStatus}
                onReady={handleReady}
                onError={handleViewerError}
              />
            </Suspense>
          </>
        ) : (
          <div className="empty-state">
            <div className="scan-illustration" aria-hidden="true">
              <div className="scan-ring scan-ring--outer" />
              <div className="scan-ring scan-ring--middle" />
              <div className="scan-ring scan-ring--inner" />
              <div className="scan-cross scan-cross--horizontal" />
              <div className="scan-cross scan-cross--vertical" />
              <div className="scan-center" />
            </div>
            <p className="eyebrow">ЛОКАЛЬНЫЙ ПРОСМОТР КЛКТ</p>
            <h2>{dragging ? 'Отпустите файл для загрузки' : 'Откройте DICOM-том'}</h2>
            <p className="empty-copy">
              Один multi-frame файл — все срезы исследования. Имя и расширение файла не имеют значения.
            </p>
            <button className="primary-button" onClick={() => inputRef.current?.click()}>
              <span aria-hidden="true">＋</span> Выбрать файл
            </button>
            <p className="privacy-note">
              <span aria-hidden="true">◈</span> Файл обрабатывается только в браузере и не отправляется на сервер
            </p>
          </div>
        )}
      </section>

      <footer className="app-footer">
        <span>3Dent Viewer <span className="footer-separator">/</span> MPR</span>
        <span>Данные остаются на этом устройстве</span>
      </footer>

      <input
        ref={inputRef}
        className="file-input"
        type="file"
        onChange={(event) => {
          void loadFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />

      {loading && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card">
            <div className="loading-spinner" />
            <p className="eyebrow">ОБРАБОТКА ИССЛЕДОВАНИЯ</p>
            <h2>{loading.message}</h2>
            <div className="progress-track">
              <span style={{ width: `${loading.progress}%` }} />
            </div>
            <div className="progress-caption">
              <span>Не закрывайте эту вкладку</span>
              <strong>{loading.progress}%</strong>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="toast-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{error}</p>
          <button aria-label="Закрыть сообщение" onClick={() => setError(null)}>×</button>
        </div>
      )}
    </main>
  );
}
