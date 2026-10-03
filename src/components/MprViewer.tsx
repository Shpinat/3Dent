import { useEffect, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import type { ParsedDicomVolume } from '../dicom/types';
import { initializeCornerstone } from '../cornerstone';

const VIEWPORTS = [
  { id: 'axial', label: 'Axial', orientation: cornerstone.Enums.OrientationAxis.AXIAL },
  { id: 'sagittal', label: 'Sagittal', orientation: cornerstone.Enums.OrientationAxis.SAGITTAL },
  { id: 'coronal', label: 'Coronal', orientation: cornerstone.Enums.OrientationAxis.CORONAL },
] as const;

interface MprViewerProps {
  volume: ParsedDicomVolume;
  onStatus: (message: string, progress: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
}

export function MprViewer({ volume, onStatus, onReady, onError }: MprViewerProps) {
  const elementRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    let disposed = false;
    let renderingEngine: cornerstone.RenderingEngine | undefined;
    let toolGroupId: string | undefined;
    let volumeId: string | undefined;
    let localImageMetadataProvider:
      | ((type: string, ...queries: unknown[]) => unknown)
      | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const setup = async () => {
      try {
        onStatus('Инициализация WebGL и MPR…', 93);
        await initializeCornerstone();
        if (disposed) return;

        const suffix = crypto.randomUUID();
        const renderingEngineId = `mpr-engine-${suffix}`;
        toolGroupId = `mpr-tools-${suffix}`;
        volumeId = `local:dicom-volume-${suffix}`;
        renderingEngine = new cornerstone.RenderingEngine(renderingEngineId);

        const viewportInputs = VIEWPORTS.map(({ id, orientation }) => {
          const element = elementRefs.current[id];
          if (!element) throw new Error(`Не найдено окно ${id} для рендеринга.`);
          return {
            viewportId: id,
            type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
            element,
            defaultOptions: {
              orientation,
              background: [0.025, 0.035, 0.05] as [number, number, number],
            },
          };
        });
        renderingEngine.setViewports(viewportInputs);

        onStatus('Создание 3D-объема…', 96);
        const volumeObject = cornerstone.volumeLoader.createLocalVolume(volumeId, {
          metadata: volume.metadata,
          dimensions: volume.dimensions,
          spacing: volume.spacing,
          origin: volume.origin,
          direction: volume.direction,
          scalarData: volume.scalarData,
        });
        if (!volumeObject) throw new Error('Cornerstone не создал локальный том.');
        const imageIds = volumeObject.imageIds;
        if (!imageIds || imageIds.length !== volume.numberOfFrames) {
          throw new Error('Cornerstone не создал метаданные для всех срезов тома.');
        }
        const rowCosines: cornerstone.Types.Point3 = [
          volume.direction[0],
          volume.direction[1],
          volume.direction[2],
        ];
        const columnCosines: cornerstone.Types.Point3 = [
          volume.direction[3],
          volume.direction[4],
          volume.direction[5],
        ];
        const normal = volume.direction.slice(6, 9);
        const imagePlaneMetadata = new Map<string, cornerstone.Types.ImagePlaneModule>();
        imageIds.forEach((imageId, index) => {
          const imagePositionPatient: [number, number, number] = [
            volume.origin[0] + normal[0] * volume.spacing[2] * index,
            volume.origin[1] + normal[1] * volume.spacing[2] * index,
            volume.origin[2] + normal[2] * volume.spacing[2] * index,
          ];
          imagePlaneMetadata.set(imageId, {
            frameOfReferenceUID: volume.metadata.FrameOfReferenceUID,
            rows: volume.dimensions[1],
            columns: volume.dimensions[0],
            rowCosines,
            columnCosines,
            imageOrientationPatient: volume.metadata.ImageOrientationPatient,
            imagePositionPatient,
            pixelSpacing: [volume.spacing[1], volume.spacing[0]],
            rowPixelSpacing: volume.spacing[1],
            columnPixelSpacing: volume.spacing[0],
            sliceThickness: volume.sliceThickness,
            spacingBetweenSlices: volume.spacing[2],
            sliceLocation: imagePositionPatient[0] * normal[0] +
              imagePositionPatient[1] * normal[1] +
              imagePositionPatient[2] * normal[2],
          });
        });
        localImageMetadataProvider = (type, ...queries) => {
          const imageId = queries[0];
          if (type !== cornerstone.Enums.MetadataModules.IMAGE_PLANE || typeof imageId !== 'string') {
            return undefined;
          }
          return imagePlaneMetadata.get(imageId);
        };
        cornerstone.metaData.addProvider(localImageMetadataProvider, 1000);

        const viewports = VIEWPORTS.map(({ id }) => {
          const viewport = renderingEngine!.getViewport(id);
          if (!(viewport instanceof cornerstone.VolumeViewport)) {
            throw new Error(`Окно ${id} не является Volume Viewport.`);
          }
          return viewport;
        });
        await Promise.all(viewports.map((viewport) => viewport.setVolumes([{ volumeId: volumeId! }])));
        for (const viewport of viewports) {
          viewport.setProperties({
            voiRange: {
              lower: volume.windowCenter - volume.windowWidth / 2,
              upper: volume.windowCenter + volume.windowWidth / 2,
            },
            invert: volume.isMonochrome1,
          });
        }

        cornerstoneTools.addTool(cornerstoneTools.CrosshairsTool);
        cornerstoneTools.addTool(cornerstoneTools.WindowLevelTool);
        cornerstoneTools.addTool(cornerstoneTools.PanTool);
        cornerstoneTools.addTool(cornerstoneTools.ZoomTool);
        const toolGroup = cornerstoneTools.ToolGroupManager.createToolGroup(toolGroupId);
        if (!toolGroup) throw new Error('Не удалось создать группу инструментов Cornerstone.');
        for (const { id } of VIEWPORTS) toolGroup.addViewport(id, renderingEngineId);
        toolGroup.addTool(cornerstoneTools.CrosshairsTool.toolName);
        toolGroup.addTool(cornerstoneTools.WindowLevelTool.toolName);
        toolGroup.addTool(cornerstoneTools.PanTool.toolName);
        toolGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        toolGroup.setToolActive(cornerstoneTools.CrosshairsTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        toolGroup.setToolActive(cornerstoneTools.WindowLevelTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });
        toolGroup.setToolActive(cornerstoneTools.PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });
        toolGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
          bindings: [{
            mouseButton: cornerstoneTools.Enums.MouseBindings.Primary,
            modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift,
          }],
        });

        renderingEngine.render();
        resizeObserver = new ResizeObserver(() => renderingEngine?.resize(true, true));
        for (const { id } of VIEWPORTS) {
          const element = elementRefs.current[id];
          if (element) resizeObserver.observe(element);
        }
        if (!disposed) onReady();
      } catch (error) {
        if (!disposed) {
          onError(error instanceof Error ? error.message : 'Не удалось инициализировать MPR.');
        }
      }
    };

    void setup();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (localImageMetadataProvider) {
        cornerstone.metaData.removeProvider(localImageMetadataProvider);
      }
      if (toolGroupId) cornerstoneTools.ToolGroupManager.destroyToolGroup(toolGroupId);
      renderingEngine?.destroy();
      if (volumeId && cornerstone.cache.getVolume(volumeId)) {
        cornerstone.cache.removeVolumeLoadObject(volumeId);
      }
    };
  }, [onError, onReady, onStatus, volume]);

  return (
    <section className="mpr-grid" aria-label="Мультипланарная реконструкция">
      {VIEWPORTS.map(({ id, label }) => (
        <article className="viewport-card" key={id}>
          <header className="viewport-heading">
            <span className={`plane-dot plane-dot--${id}`} />
            <h2>{label}</h2>
            <span className="viewport-hint">MPR</span>
          </header>
          <div
            className="viewport-canvas"
            ref={(element) => {
              elementRefs.current[id] = element;
            }}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={`${label} срез`}
          />
        </article>
      ))}
      <div className="interaction-hint">
        <span><kbd>ЛКМ</kbd> перекрестие</span>
        <span><kbd>ПКМ</kbd> окно/уровень</span>
        <span><kbd>Средняя кнопка</kbd> панорамирование</span>
        <span><kbd>Shift</kbd> + <kbd>ЛКМ</kbd> масштаб</span>
      </div>
    </section>
  );
}
