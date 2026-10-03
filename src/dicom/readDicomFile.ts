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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const worker = new Worker(new URL('./dicomParser.worker.ts', import.meta.url), {
      type: 'module',
    });

    const cleanUp = () => {
      worker.terminate();
      reader.onload = null;
      reader.onerror = null;
      reader.onprogress = null;
    };

    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress({ loaded: event.loaded, total: event.total, stage: 'reading' });
      }
    };
    reader.onerror = () => {
      cleanUp();
      reject(reader.error ?? new Error('Не удалось прочитать локальный файл.'));
    };
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        cleanUp();
        reject(new Error('FileReader не вернул ArrayBuffer.'));
        return;
      }
      onProgress({ loaded: file.size, total: file.size, stage: 'parsing' });
      worker.postMessage({ buffer: reader.result, sourceName: file.name }, [reader.result]);
    };

    worker.onerror = (event) => {
      cleanUp();
      reject(new Error(`Ошибка DICOM Worker: ${event.message || 'не удалось обработать файл.'}`));
    };
    worker.onmessage = (event: MessageEvent<SerializedDicomVolume | { error: string }>) => {
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

    reader.readAsArrayBuffer(file);
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
