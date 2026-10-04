import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { readDicomFiles, type ReadProgress } from './dicom/readDicomFile';
import type { ParsedDicomVolume } from './dicom/types';

const MprViewer = lazy(() =>
  import('./components/MprViewer').then((module) => ({ default: module.MprViewer })),
);

interface LoadingState {
  message: string;
  progress: number;
}

async function getFilesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => resolve([file]), reject);
    });
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const files = await Promise.all(children.map(getFilesFromEntry));
  return files.flat();
}

async function getDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntry | null;
    }).webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined);
  if (entries.length === 0) return Array.from(dataTransfer.files);
  const files = await Promise.all(entries.map(getFilesFromEntry));
  return files.flat();
}

async function hasDicomSignature(file: File): Promise<boolean> {
  const signature = new Uint8Array(await file.slice(128, 132).arrayBuffer());
  return signature.length === 4 &&
    signature[0] === 0x44 &&
    signature[1] === 0x49 &&
    signature[2] === 0x43 &&
    signature[3] === 0x4d;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
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

  const loadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      setError('Папка не содержит файлов для загрузки.');
      setLoading(null);
      return;
    }
    setVolume(null);
    setError(null);
    setLoading({ message: 'Подготовка чтения…', progress: 0 });
    try {
      let dicomFiles = files;
      if (files.length > 1) {
        dicomFiles = [];
        for (const file of files) {
          if (await hasDicomSignature(file)) dicomFiles.push(file);
        }
        if (dicomFiles.length === 0) {
          throw new Error('В выбранной папке не найдены файлы DICOM с сигнатурой DICM.');
        }
      }
      const parsedVolume = await readDicomFiles(dicomFiles, handleProgress);
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

  const handleDrop = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    setLoading({ message: 'Чтение содержимого папки…', progress: 0 });
    try {
      await loadFiles(await getDroppedFiles(event.dataTransfer));
    } catch (dropError) {
      setError(dropError instanceof Error ? dropError.message : 'Не удалось прочитать папку.');
      setLoading(null);
    }
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
              <button className="change-file-button" onClick={() => folderInputRef.current?.click()}>
                Открыть папку
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
            <h2>{dragging ? 'Отпустите файл или папку' : 'Откройте DICOM-том'}</h2>
            <p className="empty-copy">
              Перетащите multi-frame файл или папку с отдельными срезами. Имя и расширение не имеют значения.
            </p>
            <button className="primary-button" onClick={() => inputRef.current?.click()}>
              <span aria-hidden="true">＋</span> Выбрать файл
            </button>
            <button className="folder-button" onClick={() => folderInputRef.current?.click()}>
              Выбрать папку
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
          void loadFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={(input) => {
          folderInputRef.current = input;
          input?.setAttribute('webkitdirectory', '');
          input?.setAttribute('directory', '');
        }}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => {
          void loadFiles(Array.from(event.currentTarget.files ?? []));
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
