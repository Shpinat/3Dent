import { useEffect, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import type { ParsedDicomVolume } from '../dicom/types';
import { initializeCornerstone } from '../cornerstone';

const VIEWPORTS = [
  { id: 'axial', label: 'Axial', orientation: cornerstone.Enums.OrientationAxis.AXIAL, type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC },
  { id: 'sagittal', label: 'Sagittal', orientation: cornerstone.Enums.OrientationAxis.SAGITTAL, type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC },
  { id: 'coronal', label: 'Coronal', orientation: cornerstone.Enums.OrientationAxis.CORONAL, type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC },
  { id: 'volume3d', label: '3D Render', orientation: cornerstone.Enums.OrientationAxis.CORONAL, type: cornerstone.Enums.ViewportType.VOLUME_3D },
] as const;

function isPoint3(point: unknown): point is cornerstone.Types.Point3 {
  return Array.isArray(point) && point.length === 3 &&
    point.every((coordinate) => typeof coordinate === 'number');
}

class CursorCrosshairsTool extends cornerstoneTools.CrosshairsTool {
  constructor(...args: ConstructorParameters<typeof cornerstoneTools.CrosshairsTool>) {
    super(...args);

    const mouseMoveCallback = this.mouseMoveCallback;
    this.mouseMoveCallback = (...eventArgs) => {
      const [event, annotations] = eventArgs;
      const viewport = cornerstone.getEnabledElement(event.detail.element)?.viewport;
      const pointer = event.detail.currentPoints.canvas;
      const overRotationHandle = viewport && annotations?.some((annotation) => {
        const rotationPoints = annotation.data.handles?.['rotationPoints'];
        return Array.isArray(rotationPoints) && rotationPoints.some((handle: unknown) => {
          if (!Array.isArray(handle) || !isPoint3(handle[0])) return false;
          const point = viewport.worldToCanvas(handle[0]);
          return Math.hypot(point[0] - pointer[0], point[1] - pointer[1]) <= 8;
        });
      });
      const needsRender = mouseMoveCallback(...eventArgs);
      event.detail.element.style.cursor = overRotationHandle ? 'grab' : '';
      return needsRender;
    };

    const handleSelectedCallback = this.handleSelectedCallback;
    this.handleSelectedCallback = (...eventArgs) => {
      handleSelectedCallback(...eventArgs);
      if (eventArgs[1].data.handles?.['activeOperation'] === 2) {
        eventArgs[0].detail.element.style.cursor = 'grabbing';
      }
    };

    const toolSelectedCallback = this.toolSelectedCallback;
    this.toolSelectedCallback = (...eventArgs) => {
      toolSelectedCallback(...eventArgs);
      if (eventArgs[1].data.handles?.['activeOperation'] === 2) {
        eventArgs[0].detail.element.style.cursor = 'grabbing';
      }
    };

    const endCallback = this._endCallback;
    this._endCallback = (...eventArgs) => {
      endCallback(...eventArgs);
      eventArgs[0].detail.element.style.cursor = '';
    };
  }
}

function createSynchronizedWindowLevelTool(
  viewports: cornerstone.VolumeViewport[],
  toolName: string,
) {
  return class SynchronizedWindowLevelTool extends cornerstoneTools.WindowLevelTool {
    static toolName = toolName;

    constructor(...args: ConstructorParameters<typeof cornerstoneTools.WindowLevelTool>) {
      super(...args);

      const mouseDragCallback = this.mouseDragCallback.bind(this);
      this.mouseDragCallback = (event) => {
        mouseDragCallback(event);
        const sourceViewport = cornerstone.getEnabledElement(event.detail.element)?.viewport;
        if (!(sourceViewport instanceof cornerstone.VolumeViewport)) return;

        const { voiRange, VOILUTFunction } = sourceViewport.getProperties() ?? {};
        if (!voiRange) return;
        for (const viewport of viewports) {
          if (viewport === sourceViewport) continue;
          if ('setProperties' in viewport) { (viewport as cornerstone.VolumeViewport).setProperties({ voiRange, VOILUTFunction }); }
          viewport.render();
        }
      };
    }
  };
}

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
    let toolGroup3D: any;
    let volumeId: string | undefined;
    let localImageMetadataProvider:
      | ((type: string, ...queries: unknown[]) => unknown)
      | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const suffix = crypto.randomUUID();
    const renderingEngineId = `mpr-engine-${suffix}`;

    const setup = async () => {
      try {
        onStatus('Инициализация WebGL и MPR…', 93);
        await initializeCornerstone();
        if (disposed) return;

        toolGroupId = `mpr-tools-${suffix}`;
        volumeId = `local:dicom-volume-${suffix}`;
        renderingEngine = new cornerstone.RenderingEngine(renderingEngineId);

        const viewportInputs = VIEWPORTS.map(({ id, orientation, type }) => {
          const element = elementRefs.current[id];
          if (!element) throw new Error(`Не найдено окно ${id} для рендеринга.`);
          return {
            viewportId: id,
            type,
            element,
            defaultOptions: {
              orientation,
              background: type === cornerstone.Enums.ViewportType.VOLUME_3D
                ? [0.1, 0.1, 0.1] as [number, number, number]
                : [0.025, 0.035, 0.05] as [number, number, number],
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
          if (!(viewport instanceof cornerstone.VolumeViewport) && viewport.type !== cornerstone.Enums.ViewportType.VOLUME_3D) {
            throw new Error(`Окно ${id} не является Volume/3D Viewport.`);
          }
          return viewport;
        });

        await Promise.all(viewports.map(async (viewport) => {
           if (viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) {
             await (viewport as cornerstone.Types.IVolumeViewport).setVolumes([{
               volumeId: volumeId!,
               blendMode: cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
             }]);
           } else {
             await (viewport as cornerstone.Types.IVolumeViewport).setVolumes([{ volumeId: volumeId! }]);
           }
        }));
        for (const viewport of viewports) {
          if ('setProperties' in viewport) {
            (viewport as cornerstone.VolumeViewport).setProperties({
              voiRange: {
                lower: volume.windowCenter - volume.windowWidth / 2,
                upper: volume.windowCenter + volume.windowWidth / 2,
              },
              invert: volume.isMonochrome1,
            });
          }
        }

        const SynchronizedWindowLevelTool = createSynchronizedWindowLevelTool(viewports.filter(v => v instanceof cornerstone.VolumeViewport) as cornerstone.VolumeViewport[], `WindowLevel-${suffix}`);
        cornerstoneTools.addTool(CursorCrosshairsTool);
        cornerstoneTools.addTool(SynchronizedWindowLevelTool);
        cornerstoneTools.addTool(cornerstoneTools.PanTool);
        cornerstoneTools.addTool(cornerstoneTools.ZoomTool);
        const toolGroup = cornerstoneTools.ToolGroupManager.createToolGroup(toolGroupId);
        const toolGroup3D = cornerstoneTools.ToolGroupManager.createToolGroup(toolGroupId + '-3d');

        if (!toolGroup || !toolGroup3D) throw new Error('Не удалось создать группу инструментов Cornerstone.');

        cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool);

        for (const { id, type } of VIEWPORTS) {
          if (type === cornerstone.Enums.ViewportType.VOLUME_3D) {
            toolGroup3D.addViewport(id, renderingEngineId);
          } else {
            toolGroup.addViewport(id, renderingEngineId);
          }
        }

        // Setup 2D MPR Tools
        toolGroup.addTool(CursorCrosshairsTool.toolName);
        toolGroup.addTool(SynchronizedWindowLevelTool.toolName);
        toolGroup.addTool(cornerstoneTools.PanTool.toolName);
        toolGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        toolGroup.setToolActive(CursorCrosshairsTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
        toolGroup.setToolActive(SynchronizedWindowLevelTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] });
        toolGroup.setToolActive(cornerstoneTools.PanTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }] });
        toolGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }] });

        // Setup 3D Tools
        toolGroup3D.addTool(cornerstoneTools.TrackballRotateTool.toolName);
        toolGroup3D.addTool(cornerstoneTools.ZoomTool.toolName);
        toolGroup3D.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
        toolGroup3D.setToolActive(cornerstoneTools.ZoomTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }] });


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

      if (toolGroupId) {
        const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(toolGroupId);
        if (toolGroup) {
          VIEWPORTS.forEach(({ id }) => toolGroup.removeViewports(renderingEngineId, id));
        }
        cornerstoneTools.ToolGroupManager.destroyToolGroup(toolGroupId);
        if (toolGroup3D) {
          VIEWPORTS.forEach(({ id }) => {
            try { toolGroup3D.removeViewports(renderingEngineId, id); } catch(e){}
          });
          cornerstoneTools.ToolGroupManager.destroyToolGroup(toolGroupId + '-3d');
        }
      }

      if (renderingEngine) {
        renderingEngine.destroy();
      }

      if (volumeId && cornerstone.cache.getVolume(volumeId)) {
        cornerstone.cache.removeVolumeLoadObject(volumeId);
      }

      // Critical for 180MB files: completely purge cache and WebGL textures
      cornerstone.cache.purgeCache();
    };
  }, [onError, onReady, onStatus, volume]);

  return (
    <section className="mpr-grid" aria-label="Мультипланарная реконструкция">
      {VIEWPORTS.map(({ id, label, type }) => (
        <article className="viewport-card" key={id}>
          <header className="viewport-heading">
            <span className={`plane-dot plane-dot--${id}`} />
            <h2>{label}</h2>
            <span className="viewport-hint">{type === cornerstone.Enums.ViewportType.VOLUME_3D ? '3D' : 'MPR'}</span>
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
        <span><kbd>ПКМ</kbd> окно/уровень во всех окнах</span>
        <span><kbd>Средняя кнопка</kbd> панорамирование</span>
        <span><kbd>Колесико</kbd> масштаб</span>
      </div>
    </section>
  );
}
