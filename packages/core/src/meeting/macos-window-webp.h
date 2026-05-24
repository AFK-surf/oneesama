#pragma once

#include <stddef.h>
#include <stdint.h>

size_t oneesama_webp_encode_bgra_fast(
  const uint8_t *bgra,
  int width,
  int height,
  int stride,
  float quality,
  uint8_t **output
);

void oneesama_webp_free(void *ptr);
