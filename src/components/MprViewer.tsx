import { useEffect, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import type { ParsedDicomVolume, VolumeSavedState } from '../dicom/types';
import { initializeCornerstone } from '../cornerstone';

const VIEWPORTS = [
  { id: 'axial', label: 'Axial', orientation: cornerstone.Enums.OrientationAxis.AXIAL },
  { id: 'sagittal', label: 'Sagittal', orientation: cornerstone.Enums.OrientationAxis.SAGITTAL },
  { id: 'coronal', label: 'Coronal', orientation: cornerstone.Enums.OrientationAxis.CORONAL },
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
          viewport.setProperties({ voiRange, VOILUTFunction }, undefined, true);
          viewport.render();
        }
      };
    }
  };
}

interface MprViewerProps {
  studyId: string;
  volume: ParsedDicomVolume;
  savedState?: VolumeSavedState;
  onSaveState?: (state: VolumeSavedState) => void;
  onStatus: (message: string, progress: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
}

const renderingEngineId = 'mpr-engine-shared';
const toolGroupId = 'mpr-tools-shared';

export function MprViewer({ studyId, volume, savedState, onSaveState, onStatus, onReady, onError }: MprViewerProps) {
  const elementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const engineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const toolGroupRef = useRef<ReturnType<typeof cornerstoneTools.ToolGroupManager.getToolGroup> | null>(null);
  const localImageMetadataProviderRef = useRef<((type: string, ...queries: unknown[]) => unknown) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    let disposed = false;

    const setupEngine = async () => {
      try {
        if (!engineRef.current) {
          onStatus('Инициализация WebGL и MPR…', 93);
          await initializeCornerstone();
          if (disposed) return;
          engineRef.current = new cornerstone.RenderingEngine(renderingEngineId);
        }

        const renderingEngine = engineRef.current;
        if (!renderingEngine) {
           throw new Error('Не удалось инициализировать движок рендеринга');
        }
        if (disposed) return;

        // Setup viewports if they don't exist yet in the engine
        const existingViewports = renderingEngine.getViewports();
        if (existingViewports.length === 0) {
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
        }

        const volumeId = `local:dicom-volume-${studyId}`;

        onStatus('Создание 3D-объема…', 96);
        let volumeObject = cornerstone.cache.getVolume(volumeId);
        if (!volumeObject) {
          volumeObject = cornerstone.volumeLoader.createLocalVolume(volumeId, {
            metadata: volume.metadata,
            dimensions: volume.dimensions,
            spacing: volume.spacing,
            origin: volume.origin,
            direction: volume.direction,
            scalarData: volume.scalarData,
          });
        }

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

        if (localImageMetadataProviderRef.current) {
          cornerstone.metaData.removeProvider(localImageMetadataProviderRef.current);
        }
        const localImageMetadataProvider = (type: string, ...queries: unknown[]) => {
          const imageId = queries[0];
          if (type !== cornerstone.Enums.MetadataModules.IMAGE_PLANE || typeof imageId !== 'string') {
            return undefined;
          }
          return imagePlaneMetadata.get(imageId);
        };
        localImageMetadataProviderRef.current = localImageMetadataProvider;
        cornerstone.metaData.addProvider(localImageMetadataProvider, 1000);

        const viewports = VIEWPORTS.map(({ id }) => {
          const viewport = renderingEngine!.getViewport(id);
          if (!(viewport instanceof cornerstone.VolumeViewport)) {
            throw new Error(`Окно ${id} не является Volume Viewport.`);
          }
          return viewport;
        });
        await Promise.all(viewports.map((viewport) => viewport.setVolumes([{ volumeId: volumeId }])));
        for (const viewport of viewports) {
          viewport.setProperties({
            voiRange: {
              lower: volume.windowCenter - volume.windowWidth / 2,
              upper: volume.windowCenter + volume.windowWidth / 2,
            },
            invert: volume.isMonochrome1,
          });
        }

        if (!toolGroupRef.current) {
          const SynchronizedWindowLevelTool = createSynchronizedWindowLevelTool(
            viewports,
            `WindowLevel-shared`,
          );

          if (!cornerstoneTools.state.tools[CursorCrosshairsTool.toolName]) cornerstoneTools.addTool(CursorCrosshairsTool);
          if (!cornerstoneTools.state.tools[SynchronizedWindowLevelTool.toolName]) cornerstoneTools.addTool(SynchronizedWindowLevelTool);
          if (!cornerstoneTools.state.tools[cornerstoneTools.PanTool.toolName]) cornerstoneTools.addTool(cornerstoneTools.PanTool);
          if (!cornerstoneTools.state.tools[cornerstoneTools.ZoomTool.toolName]) cornerstoneTools.addTool(cornerstoneTools.ZoomTool);

          let toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(toolGroupId) || cornerstoneTools.ToolGroupManager.createToolGroup(toolGroupId);
          if (!toolGroup) throw new Error('Не удалось создать группу инструментов Cornerstone.');
          toolGroupRef.current = toolGroup;

          for (const { id } of VIEWPORTS) toolGroup.addViewport(id, renderingEngineId);
          toolGroup.addTool(CursorCrosshairsTool.toolName);
          toolGroup.addTool(SynchronizedWindowLevelTool.toolName);
          toolGroup.addTool(cornerstoneTools.PanTool.toolName);
          toolGroup.addTool(cornerstoneTools.ZoomTool.toolName);
          toolGroup.setToolActive(CursorCrosshairsTool.toolName, {
            bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
          });
          toolGroup.setToolActive(SynchronizedWindowLevelTool.toolName, {
            bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
          });
          toolGroup.setToolActive(cornerstoneTools.PanTool.toolName, {
            bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
          });
          toolGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
            bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
          });
        }

        renderingEngine.render();

        if (savedState) {
          VIEWPORTS.forEach(({ id }) => {
            const viewport = renderingEngine?.getViewport(id);
            const viewportState = savedState.viewports[id];
            if (viewport && viewport instanceof cornerstone.VolumeViewport && viewportState) {
              if (viewportState.camera) {
                viewport.setCamera(viewportState.camera);
              }
              if (viewportState.voi) {
                const voiRange = {
                  lower: viewportState.voi.windowCenter - viewportState.voi.windowWidth / 2,
                  upper: viewportState.voi.windowCenter + viewportState.voi.windowWidth / 2,
                };
                viewport.setProperties({ voiRange });
              }
            }
          });
          renderingEngine.render();
        }

        if (resizeObserverRef.current) {
           resizeObserverRef.current.disconnect();
        }

        resizeObserverRef.current = new ResizeObserver(() => {
            engineRef.current?.resize(true, true);
        });
        for (const { id } of VIEWPORTS) {
          const element = elementRefs.current[id];
          if (element) resizeObserverRef.current.observe(element);
        }

        if (!disposed) onReady();
      } catch (error) {
        if (!disposed) {
          onError(error instanceof Error ? error.message : 'Не удалось инициализировать MPR.');
        }
      }
    };

    void setupEngine();
    return () => {
      disposed = true;
      resizeObserverRef.current?.disconnect();
      
      if (engineRef.current && onSaveState) {
        const stateToSave: VolumeSavedState = { viewports: {} };
        VIEWPORTS.forEach(({ id }) => {
          const viewport = engineRef.current?.getViewport(id);
          if (viewport && viewport instanceof cornerstone.VolumeViewport) {
            const camera = viewport.getCamera();
            const properties = viewport.getProperties();
            stateToSave.viewports[id] = {
              camera,
              voi: properties?.voiRange ? {
                windowWidth: properties.voiRange.upper - properties.voiRange.lower,
                windowCenter: (properties.voiRange.upper + properties.voiRange.lower) / 2,
              } : undefined,
            };
          }
        });
        onSaveState(stateToSave);
      }
    };
  }, [studyId, volume, savedState, onSaveState, onStatus, onReady, onError]);

  // Cleanup effect when the component entirely unmounts
  useEffect(() => {
      return () => {
          if (localImageMetadataProviderRef.current) {
              cornerstone.metaData.removeProvider(localImageMetadataProviderRef.current);
              localImageMetadataProviderRef.current = null;
          }

          if (toolGroupRef.current) {
            VIEWPORTS.forEach(({ id }) => toolGroupRef.current?.removeViewports(renderingEngineId, id));
            cornerstoneTools.ToolGroupManager.destroyToolGroup(toolGroupId);
            toolGroupRef.current = null;
          }

          if (engineRef.current) {
              engineRef.current.destroy();
              engineRef.current = null;
          }

          // Critical for 180MB files: completely purge cache and WebGL textures
          cornerstone.cache.purgeCache();
      };
  }, []);

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
        <span><kbd>ПКМ</kbd> окно/уровень во всех окнах</span>
        <span><kbd>Средняя кнопка</kbd> панорамирование</span>
        <span><kbd>Колесико</kbd> масштаб</span>
      </div>
    </section>
  );
}
