#include "macos-window-webp.h"

#include <stdlib.h>
#include <webp/encode.h>

#define ONEESAMA_WEBP_MAX_DIMENSION 2160

size_t oneesama_webp_encode_bgra_fast(
  const uint8_t *bgra,
  int width,
  int height,
  int stride,
  float quality,
  uint8_t **output
) {
  if (!bgra || !output || width <= 0 || height <= 0 || stride <= 0) return 0;

  WebPConfig config;
  if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, quality)) return 0;
  config.method = 0;
  config.thread_level = 1;
  config.low_memory = 1;
  if (!WebPValidateConfig(&config)) return 0;

  WebPPicture picture;
  if (!WebPPictureInit(&picture)) return 0;
  picture.width = width;
  picture.height = height;
  picture.use_argb = 0;

  WebPMemoryWriter writer;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = &writer;

  if (!WebPPictureImportBGRA(&picture, bgra, stride)) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 0;
  }
  if (width > ONEESAMA_WEBP_MAX_DIMENSION || height > ONEESAMA_WEBP_MAX_DIMENSION) {
    const double scale =
      width >= height ? (double)ONEESAMA_WEBP_MAX_DIMENSION / (double)width
                      : (double)ONEESAMA_WEBP_MAX_DIMENSION / (double)height;
    const int scaled_width = (int)((double)width * scale + 0.5);
    const int scaled_height = (int)((double)height * scale + 0.5);
    if (!WebPPictureRescale(&picture, scaled_width, scaled_height)) {
      WebPPictureFree(&picture);
      WebPMemoryWriterClear(&writer);
      return 0;
    }
  }
  if (!WebPEncode(&config, &picture)) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 0;
  }

  WebPPictureFree(&picture);
  *output = writer.mem;
  return writer.size;
}

void oneesama_webp_free(void *ptr) {
  WebPFree(ptr);
}
