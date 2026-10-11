import { unzip } from 'fflate';

export async function processInputFiles(entries: FileSystemEntry[] | File[]): Promise<File[]> {
  const allFiles: File[] = [];

  for (const entry of entries) {
    if ('isFile' in entry && entry.isFile) {
      const file = await getFileFromEntry(entry as FileSystemFileEntry);
      allFiles.push(file);
    } else if ('isDirectory' in entry && entry.isDirectory) {
      const dirFiles = await getFilesFromDirEntry(entry as unknown as FileSystemDirectoryEntry);
      allFiles.push(...dirFiles);
    } else if (entry instanceof File) {
      allFiles.push(entry);
    }
  }

  const finalFiles: File[] = [];
  for (const file of allFiles) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const extractedFiles = await extractZip(file);
      finalFiles.push(...extractedFiles);
    } else {
      finalFiles.push(file);
    }
  }

  return finalFiles;
}

function getFileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function getFilesFromDirEntry(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const dirReader = dirEntry.createReader();
    const files: File[] = [];

    function readEntries() {
      dirReader.readEntries(async (entries) => {
        if (entries.length === 0) {
          resolve(files);
        } else {
          try {
            const batch = await processInputFiles(entries);
            files.push(...batch);
            readEntries();
          } catch (err) {
            reject(err);
          }
        }
      }, reject);
    }

    readEntries();
  });
}

async function extractZip(zipFile: File): Promise<File[]> {
  const buffer = new Uint8Array(await zipFile.arrayBuffer());
  return new Promise((resolve, reject) => {
    unzip(buffer, (err, unzipped) => {
      if (err) return reject(err);

      const files: File[] = [];
      for (const [path, data] of Object.entries(unzipped)) {
        if (data.length === 0 && path.endsWith('/')) continue; // Skip directories

        const filename = path.split('/').pop() || 'unknown';
        const file = new File([data], filename, {
            type: getMimeType(filename),
            lastModified: zipFile.lastModified
        });
        // We might want to keep the relative path information.
        // It's not officially possible to set webkitRelativePath dynamically,
        // but we can use Object.defineProperty if strictly needed, or just attach a custom property.
        Object.defineProperty(file, 'webkitRelativePath', {
            value: path,
            writable: false
        });
        files.push(file);
      }
      resolve(files);
    });
  });
}

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'bmp': return 'image/bmp';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'stl': return 'model/stl';
    case 'obj': return 'model/obj';
    case 'ply': return 'text/plain';
    case 'dcm':
    case 'dicom': return 'application/dicom';
    default: return 'application/octet-stream';
  }
}
