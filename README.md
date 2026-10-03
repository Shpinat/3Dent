# 3Dent MPR Viewer

Локальное React/Vite-приложение для просмотра одного multi-frame CT DICOM в трех ортогональных плоскостях. В браузере используются Cornerstone3D Volume Viewport и WebGL; файлы на сервер не отправляются.

## Запуск

```sh
npm ci
npm run dev
```

Для проверки production-сборки:

```sh
npm run build
npm run preview
```

Точные версии зависимостей зафиксированы в `package.json` и `package-lock.json`.

## Загрузка и реконструкция

1. `FileReader.readAsArrayBuffer` читает выбранный файл и передает прогресс в интерфейс. Имя и расширение файла не используются для определения формата.
2. Инициализируются Cornerstone3D Core, Tools и DICOM Image Loader. Для локального файла без расширения `FileReader` передает сырой буфер в `dicomParser.worker.ts`, который проверяет `DICM` по смещению 128, извлекает DICOM Data Set и разбирает `NumberOfFrames`, `Rows`, `Columns`, `PixelSpacing`, `SliceThickness`, геометрию функциональных групп и Pixel Data.
3. Кадры упорядочиваются по `ImagePositionPatient` относительно нормали изображения; нерегулярный шаг между кадрами отвергается вместо создания геометрически неверного объема. Modality rescale из shared/per-frame functional groups применяется к соответствующим кадрам.
4. `createLocalVolume` создает единый Cornerstone volume. Для локальных срезов зарегистрирован cache-backed image loader и геометрия каждого кадра. Три `ORTHOGRAPHIC` Volume Viewport показывают Axial, Sagittal и Coronal; `CrosshairsTool` синхронизирует положение среза.

Основной сценарий рассчитан на монохромный CT с несжатым Pixel Data и transfer syntax Explicit VR Little Endian или Implicit VR Little Endian, 8- или 16-битными пикселями и одним sample на pixel. Сжатые/инкапсулированные данные и цветные изображения явно отклоняются: для них потребуется отдельный путь декодирования кадров. Формат DICOM с сигнатурой `DICM` в стандартной позиции 128 байт обязателен.

## Управление в MPR

- ЛКМ — перекрестие и синхронная смена позиции во всех плоскостях.
- ПКМ + перетаскивание — Window/Level.
- Средняя кнопка мыши + перетаскивание — Pan.
- Shift + ЛКМ + перетаскивание — Zoom.
