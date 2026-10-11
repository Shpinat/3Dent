import { useEffect, useState } from 'react';
import UTIF from 'utif';

interface Props {
  file: File;
}

export function Image2DViewer({ file }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl = '';

    const loadFile = async () => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'tif' || ext === 'tiff') {
        const buffer = await file.arrayBuffer();
        const ifds = UTIF.decode(buffer);
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);

        const canvas = document.createElement('canvas');
        canvas.width = ifds[0].width;
        canvas.height = ifds[0].height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const imageData = new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height);
          ctx.putImageData(imageData, 0, 0);
          objectUrl = canvas.toDataURL('image/png');
          setImageUrl(objectUrl);
        }
      } else {
        objectUrl = URL.createObjectURL(file);
        setImageUrl(objectUrl);
      }
    };

    void loadFile();

    return () => {
      if (objectUrl && objectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file]);

  if (!imageUrl) {
    return <div className="viewer-loading">Загрузка изображения...</div>;
  }

  return (
    <div className="image-2d-viewer">
      <img src={imageUrl} alt={file.name} />
    </div>
  );
}
