import type { ParsedDicomVolume, ScalarVolumeData, SerializedDicomVolume } from './types';

export interface ReadProgress {
  loaded: number;
  total: number;
  stage: 'reading' | 'parsing';
}

export function readDicomFile(
  file: File,
  onProgress: (progress: ReadProgress) => void,
): Promise<ParsedDicomVolume> {
  return readDicomFiles([file], onProgress);
}

export function readDicomFiles(
  files: File[],
  onProgress: (progress: ReadProgress) => void,
  sourceNameFallback?: string,
): Promise<ParsedDicomVolume> {
  if (files.length === 0) {
    return Promise.reject(new Error('Не выбраны файлы DICOM для загрузки.'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dicomParser.worker.ts', import.meta.url), {
      type: 'module',
    });
    const buffers: ArrayBuffer[] = [];
    const totalSize = files.reduce((total, file) => total + file.size, 0);
    let completedSize = 0;
    let currentReader: FileReader | undefined;
    let settled = false;

    const cleanUp = () => {
      settled = true;
      currentReader?.abort();
      worker.terminate();
    };

    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      cleanUp();
      reject(new Error(`Ошибка DICOM Worker: ${event.message || 'не удалось обработать файл.'}`));
    };
    worker.onmessage = (event: MessageEvent<SerializedDicomVolume | { error: string }>) => {
      if (settled) return;
      cleanUp();
      if ('error' in event.data) {
        reject(new Error(event.data.error));
        return;
      }
      resolve({
        ...event.data,
        scalarData: restoreScalarData(event.data.scalarData, event.data.scalarType),
      });
    };

    const readNextFile = (index: number) => {
      if (settled) return;
      if (index === files.length) {
        onProgress({ loaded: totalSize, total: totalSize, stage: 'parsing' });
        const defaultName = sourceNameFallback || (files.length === 1 ? files[0].name : `DICOM серия (${files.length} срезов)`);
        worker.postMessage(
          {
            buffers,
            sourceName: defaultName,
          },
          buffers,
        );
        return;
      }

      currentReader = new FileReader();
      currentReader.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress({
            loaded: completedSize + event.loaded,
            total: totalSize,
            stage: 'reading',
          });
        }
      };
      currentReader.onerror = () => {
        if (settled) return;
        const error = currentReader?.error;
        cleanUp();
        reject(error ?? new Error(`Не удалось прочитать локальный файл «${files[index].name}».`));
      };
      currentReader.onabort = () => {
        if (settled) return;
        cleanUp();
        reject(new Error(`Чтение локального файла «${files[index].name}» было прервано.`));
      };
      currentReader.onload = () => {
        if (settled) return;
        if (!(currentReader?.result instanceof ArrayBuffer)) {
          cleanUp();
          reject(new Error(`FileReader не вернул ArrayBuffer для файла «${files[index].name}».`));
          return;
        }
        buffers.push(currentReader.result);
        completedSize += files[index].size;
        onProgress({ loaded: completedSize, total: totalSize, stage: 'reading' });
        readNextFile(index + 1);
      };
      currentReader.readAsArrayBuffer(files[index]);
    };

    readNextFile(0);
  });
}

function restoreScalarData(buffer: ArrayBuffer, scalarType: string): ScalarVolumeData {
  switch (scalarType) {
    case 'Uint8Array':
      return new Uint8Array(buffer);
    case 'Int16Array':
      return new Int16Array(buffer);
    case 'Uint16Array':
      return new Uint16Array(buffer);
    case 'Float32Array':
      return new Float32Array(buffer);
    default:
      throw new Error(`Worker вернул неподдерживаемый тип пикселей: ${scalarType}.`);
  }
}
