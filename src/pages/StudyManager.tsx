import React, { useState, useRef, useEffect } from 'react';
import { Upload, Trash2, FolderOpen } from 'lucide-react';
import { useAppContext, type DicomFile } from '../context/AppContext';
import { initCornerstone } from '../lib/dicom/init';
// @ts-ignore
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

export const StudyManager: React.FC = () => {
  const { studies, setActiveStudy, addStudy, removeStudies } = useAppContext();
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedStudyIds, setSelectedStudyIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    initCornerstone().catch(console.error);
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const processFiles = async (fileList: FileList | File[]) => {
    setIsLoading(true);
    try {
      const dicomFiles: DicomFile[] = [];
      let studyName = "Unknown Study";

      const validFiles = Array.from(fileList).filter(f => f.name !== 'DICOMDIR' && !f.name.startsWith('.'));

      if (validFiles.length > 0) {
        const firstFile = validFiles[0];
        if (firstFile.webkitRelativePath) {
          const parts = firstFile.webkitRelativePath.split('/');
          if (parts.length > 1) {
             studyName = parts[0];
          }
        } else {
           studyName = `Study ${new Date().toLocaleTimeString()}`;
        }

        for (const file of validFiles) {
           // @ts-ignore
           const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(file);
           dicomFiles.push({ file, imageId });
        }

        if (dicomFiles.length > 0) {
           addStudy(studyName, dicomFiles);
        }
      }
    } catch (error) {
      console.error("Error processing files:", error);
      alert("Ошибка при загрузке файлов.");
    } finally {
      setIsLoading(false);
      setIsDragging(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const items = e.dataTransfer.items;
    const files: File[] = [];

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry();
          if (entry && entry.isDirectory) {
             alert('Для загрузки папки используйте кнопку "Загрузить папку".');
             return;
          } else {
             const file = item.getAsFile();
             if (file) files.push(file);
          }
        }
      }
    }

    if (files.length > 0) {
       await processFiles(files);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };

  const toggleSelectStudy = (id: string) => {
    const newSelected = new Set(selectedStudyIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedStudyIds(newSelected);
  };

  const handleDeleteSelected = () => {
    removeStudies(Array.from(selectedStudyIds));
    setSelectedStudyIds(new Set());
  };

  // Add the custom props required for directory selection
  const fileInputProps: any = {
    webkitdirectory: "",
    directory: ""
  };

  return (
    <div className="p-8 h-full flex flex-col max-w-6xl mx-auto w-full">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Менеджер исследований</h1>

        <div className="flex space-x-4">
          {selectedStudyIds.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="flex items-center px-4 py-2 bg-destructive text-destructive-foreground rounded-md hover:opacity-90 transition-opacity"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Удалить ({selectedStudyIds.size})
            </button>
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="animate-pulse">Загрузка...</span>
            ) : (
              <>
                <FolderOpen className="w-4 h-4 mr-2" />
                Загрузить папку
              </>
            )}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInput}
            className="hidden"
            multiple
            {...fileInputProps}
          />
        </div>
      </div>

      <div
        className={`flex-1 rounded-xl border-2 border-dashed p-6 flex flex-col transition-all overflow-hidden
          ${isDragging ? 'border-primary bg-primary/5' : 'border-border bg-card'}
        `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {studies.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground pointer-events-none">
            <Upload className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-xl mb-2">Перетащите DICOM файлы сюда</p>
            <p className="text-sm opacity-70">или нажмите "Загрузить папку"</p>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
             <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="p-4 w-12">
                      <input
                        type="checkbox"
                        checked={selectedStudyIds.size === studies.length && studies.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedStudyIds(new Set(studies.map(s => s.id)));
                          } else {
                            setSelectedStudyIds(new Set());
                          }
                        }}
                        className="rounded border-input bg-background"
                      />
                    </th>
                    <th className="p-4 font-medium">Название</th>
                    <th className="p-4 font-medium">Кол-во срезов</th>
                    <th className="p-4 font-medium">Дата загрузки</th>
                    <th className="p-4 w-32 text-right">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {studies.map(study => (
                    <tr key={study.id} className="border-b border-border/50 hover:bg-accent/50 transition-colors group">
                      <td className="p-4">
                        <input
                          type="checkbox"
                          checked={selectedStudyIds.has(study.id)}
                          onChange={() => toggleSelectStudy(study.id)}
                          className="rounded border-input bg-background"
                        />
                      </td>
                      <td className="p-4 font-medium cursor-pointer" onClick={() => setActiveStudy(study.id)}>
                        {study.name}
                      </td>
                      <td className="p-4 text-muted-foreground">{study.files.length}</td>
                      <td className="p-4 text-muted-foreground">{study.dateAdded.toLocaleString()}</td>
                      <td className="p-4 text-right">
                        <button
                          onClick={() => setActiveStudy(study.id)}
                          className="px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80 mr-2"
                        >
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
             </table>
          </div>
        )}
      </div>
    </div>
  );
};
