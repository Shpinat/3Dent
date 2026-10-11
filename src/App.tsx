import React, { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { readDicomFiles, type ReadProgress } from './dicom/readDicomFile';
import type { ParsedDicomVolume } from './dicom/types';
import { processInputFiles } from './utils/fileProcessor';
import { parseDicomdir, type DicomdirPatient } from './utils/dicomdirParser';
import { DataSelectionModal, type DataSelectionItem } from './components/DataSelectionModal';
import { Image2DViewer } from './components/Image2DViewer';
import { Mesh3DViewer } from './components/Mesh3DViewer';

const MprViewer = lazy(() =>
  import('./components/MprViewer').then((module) => ({ default: module.MprViewer })),
);

interface LoadingState {
  message: string;
  progress: number;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Studies loaded from DICOM
  const [studies, setStudies] = useState<{ id: string, volume: ParsedDicomVolume }[]>([]);
  const [activeStudyId, setActiveStudyId] = useState<string | null>(null);

  // Standalone files (2D, 3D)
  const [standaloneFiles, setStandaloneFiles] = useState<{ id: string, type: 'image_2d' | 'mesh_3d', file: File, label: string }[]>([]);
  const [activeStandaloneId, setActiveStandaloneId] = useState<string | null>(null);

  const [loading, setLoading] = useState<LoadingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Selection Modal state
  const [selectionItems, setSelectionItems] = useState<DataSelectionItem[]>([]);
  const [dicomdirData, setDicomdirData] = useState<DicomdirPatient[] | undefined>(undefined);
  const [showModal, setShowModal] = useState(false);

  const activeVolume = studies.find(s => s.id === activeStudyId)?.volume || null;
  const activeStandalone = standaloneFiles.find(s => s.id === activeStandaloneId) || null;

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

  const loadDicomSeries = useCallback(async (files: File[], label: string) => {
    setLoading({ message: 'Подготовка чтения…', progress: 0 });
    try {
      const parsedVolume = await readDicomFiles(files, handleProgress, label);
      const newStudyId = crypto.randomUUID();
      setStudies(prev => [...prev, { id: newStudyId, volume: parsedVolume }]);
      setActiveStudyId(newStudyId);
      setActiveStandaloneId(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить файл.');
    } finally {
      setLoading(null);
    }
  }, [handleProgress]);

  const handleProcessInput = async (files: File[]) => {
    if (files.length === 0) return;
    setLoading({ message: 'Распаковка и анализ файлов...', progress: 10 });
    try {
      const dicomdirFile = files.find(f => f.name.toUpperCase() === 'DICOMDIR');
      const otherFiles = files.filter(f => f.name.toUpperCase() !== 'DICOMDIR');

      let parsedDicomdir: DicomdirPatient[] | undefined;
      if (dicomdirFile) {
        try {
          parsedDicomdir = await parseDicomdir(dicomdirFile);
        } catch(e) {
          console.warn("Failed to parse DICOMDIR", e);
        }
      }

      const items: DataSelectionItem[] = [];
      const dicomFiles = otherFiles.filter(f => f.name.toLowerCase().endsWith('.dcm') || f.name.toLowerCase().endsWith('.dicom') || !f.name.includes('.'));
      const imageFiles = otherFiles.filter(f => f.type.startsWith('image/') || f.name.match(/\.(jpg|jpeg|png|bmp|tif|tiff)$/i));
      const meshFiles = otherFiles.filter(f => f.name.match(/\.(stl|obj|ply)$/i));

      if (dicomFiles.length > 0) {
        // If no dicomdir, group them all as one series for now (could be improved to read headers)
        items.push({
          id: 'dicom-series-auto',
          type: 'dicom_series',
          label: `DICOM Серия (${dicomFiles.length} файлов)`,
          files: dicomFiles
        });
      }

      for (const img of imageFiles) {
        items.push({ id: crypto.randomUUID(), type: 'image_2d', label: img.name, files: [img] });
      }

      for (const mesh of meshFiles) {
        items.push({ id: crypto.randomUUID(), type: 'mesh_3d', label: mesh.name, files: [mesh] });
      }

      if (parsedDicomdir || items.length > 1) {
        setDicomdirData(parsedDicomdir);
        setSelectionItems(items);
        setShowModal(true);
      } else if (items.length === 1) {
        // Only one thing, just open it
        handleSelectData(items[0], dicomFiles);
      } else {
        throw new Error('Поддерживаемые файлы не найдены.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка обработки файлов');
    } finally {
      setLoading(null);
    }
  };

  const handleSelectData = (item: DataSelectionItem, allDicomFiles?: File[]) => {
    setShowModal(false);
    if (item.type === 'dicom_series') {
      let filesToLoad = item.files;
      if (allDicomFiles && allDicomFiles.length > 0 && dicomdirData) {
        // Find the series in dicomdir data to get instances
        let targetSeries = null;
        for (const patient of dicomdirData) {
          for (const study of patient.studies) {
            const found = study.series.find(s => s.uid === item.id);
            if (found) { targetSeries = found; break; }
          }
          if (targetSeries) break;
        }

        if (targetSeries && targetSeries.instances.length > 0) {
           filesToLoad = allDicomFiles.filter(f => {
                          const fileName = f.name;
             return targetSeries.instances.some((inst: string) => {
               // DICOMDIR paths are like "IMAGES/0001". We check if our file's path ends with it.
               const normalizedInst = inst.replace(/\\/g, '/');
               return f.webkitRelativePath?.endsWith(normalizedInst) || fileName === normalizedInst.split('/').pop();
             });
           });
        }
      }

      if (filesToLoad.length === 0) filesToLoad = allDicomFiles || item.files;

      void loadDicomSeries(filesToLoad, item.label);
    } else {
      const newId = crypto.randomUUID();
      setStandaloneFiles(prev => [...prev, { id: newId, type: item.type as 'image_2d' | 'mesh_3d', file: item.files[0], label: item.label }]);
      setActiveStandaloneId(newId);
      setActiveStudyId(null);
    }
  };

  const removeStudy = useCallback((idToRemove: string) => {
    setStudies(prev => {
      const filtered = prev.filter(s => s.id !== idToRemove);
      if (activeStudyId === idToRemove) {
        setActiveStudyId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
      }
      return filtered;
    });
  }, [activeStudyId]);

  const removeStandalone = useCallback((idToRemove: string) => {
    setStandaloneFiles(prev => {
      const filtered = prev.filter(s => s.id !== idToRemove);
      if (activeStandaloneId === idToRemove) {
        setActiveStandaloneId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
      }
      return filtered;
    });
  }, [activeStandaloneId]);

  const handleDrop = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);

    const entries: any[] = [];
    if (event.dataTransfer.items) {
      for (let i = 0; i < event.dataTransfer.items.length; i++) {
        const item = event.dataTransfer.items[i];
        if (item.kind === 'file') {
          const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
          if (entry) {
            entries.push(entry);
          } else {
            const file = item.getAsFile();
            if (file) entries.push(file);
          }
        }
      }
    }

    if (entries.length > 0) {
      const processedFiles = await processInputFiles(entries);
      void handleProcessInput(processedFiles);
    }
  };

  return (
    <main
      className={`app-shell${dragging ? ' app-shell--dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span /><span /><span />
          </div>
          <div>
            <p className="brand-overline">DENTAL IMAGING</p>
            <h1>3Dent <span>·</span> MPR</h1>
          </div>
        </div>
        <div className="header-status">
          <span className={`status-indicator${(studies.length > 0 || standaloneFiles.length > 0) ? ' status-indicator--ready' : ''}`} />
          {studies.length > 0 || standaloneFiles.length > 0 ? 'Локальный просмотр' : 'Ожидание файла'}
        </div>
      </header>

      <div className="main-layout">
        {(studies.length > 0 || standaloneFiles.length > 0) && (
          <aside className="study-manager">
            <div className="study-manager-header">
              <h3>Менеджер файлов</h3>
              <div className="study-manager-actions">
                <button className="change-file-button" onClick={() => inputRef.current?.click()}>+ Файл</button>
                <button className="change-file-button" onClick={() => folderInputRef.current?.click()}>+ Папка</button>
              </div>
            </div>
            <ul className="study-list">
              {studies.map((study) => (
                <li key={study.id} className={`study-item${study.id === activeStudyId ? ' study-item--active' : ''}`} onClick={() => { setActiveStudyId(study.id); setActiveStandaloneId(null); }}>
                  <div className="study-item-info">
                    <strong>{study.volume.patientName || 'КЛКТ'}</strong>
                    <span>{study.volume.modality}</span>
                  </div>
                  <button className="study-item-remove" onClick={(e) => { e.stopPropagation(); removeStudy(study.id); }}>×</button>
                </li>
              ))}
              {standaloneFiles.map((sf) => (
                <li key={sf.id} className={`study-item${sf.id === activeStandaloneId ? ' study-item--active' : ''}`} onClick={() => { setActiveStandaloneId(sf.id); setActiveStudyId(null); }}>
                  <div className="study-item-info">
                    <strong>{sf.label}</strong>
                    <span>{sf.type === 'image_2d' ? '2D Изображение' : '3D Модель'}</span>
                  </div>
                  <button className="study-item-remove" onClick={(e) => { e.stopPropagation(); removeStandalone(sf.id); }}>×</button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <section className="workspace">
          {activeVolume ? (
             <div style={{width: '100%', height: '100%', display: 'flex', flexDirection: 'column'}}>
               <div className="study-bar">
                 <div className="study-title">
                   <span className="study-icon" aria-hidden="true">▦</span>
                   <div>
                     <p className="eyebrow">ТЕКУЩЕЕ ИССЛЕДОВАНИЕ</p>
                     <strong>{activeVolume.sourceName}</strong>
                   </div>
                 </div>
               </div>
               <Suspense fallback={null}>
                 <MprViewer volume={activeVolume} onStatus={(msg: string, prog: number) => setLoading({message: msg, progress: prog})} onReady={() => setLoading(null)} onError={setError} />
               </Suspense>
             </div>
          ) : activeStandalone ? (
            activeStandalone.type === 'image_2d' ? (
              <Image2DViewer file={activeStandalone.file} />
            ) : (
              <Mesh3DViewer file={activeStandalone.file} />
            )
          ) : (
            <div className="empty-state">
              <h2>{dragging ? 'Отпустите файл или папку' : 'Откройте данные'}</h2>
              <p className="empty-copy">Поддерживаются DICOM, ZIP, STL, OBJ, PLY, JPG, PNG, TIFF.</p>
              <button className="primary-button" onClick={() => inputRef.current?.click()}>Выбрать файл / ZIP</button>
              <button className="folder-button" onClick={() => folderInputRef.current?.click()}>Выбрать папку</button>
            </div>
          )}
        </section>
      </div>

      <input ref={inputRef} className="file-input" type="file" multiple onChange={(e) => {
        void processInputFiles(Array.from(e.currentTarget.files || [])).then(handleProcessInput);
        e.currentTarget.value = '';
      }} />
      <input ref={(el) => { folderInputRef.current = el; el?.setAttribute('webkitdirectory', ''); el?.setAttribute('directory', ''); }} className="file-input" type="file" multiple onChange={(e) => {
        void processInputFiles(Array.from(e.currentTarget.files || [])).then(handleProcessInput);
        e.currentTarget.value = '';
      }} />

      {showModal && (
        <DataSelectionModal
          items={selectionItems}
          dicomdir={dicomdirData}
          onSelect={(item) => handleSelectData(item, selectionItems.find(i => i.type === 'dicom_series')?.files)}
          onCancel={() => setShowModal(false)}
        />
      )}

      {loading && (
        <div className="loading-overlay" role="status">
          <div className="loading-card">
            <div className="loading-spinner" />
            <h2>{loading.message}</h2>
            <div className="progress-track"><span style={{ width: `${loading.progress}%` }} /></div>
          </div>
        </div>
      )}

      {error && (
        <div className="toast-error" role="alert">
          <p>{error}</p>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
    </main>
  );
}
