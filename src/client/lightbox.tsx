/**
 * Shared lightbox: opens a generated image full-screen with prev/next
 * navigation, keyboard support, and a download pill. Used by both the panel
 * (assets/queue previews) and the tool card (result images).
 */
import { createElement as h, useEffect } from 'react'

export interface LightboxProps {
  t: (key: string, ...rest: unknown[]) => string
  images: string[]
  /** Per-image media kind, parallel to `images`; omitted defaults to image. */
  kinds?: Array<'image' | 'video' | 'audio' | 'other'>
  /** Optional per-image labels (file names) shown in the meta row and strip. */
  labels?: string[]
  index: number
  onClose: () => void
  onIndex: (index: number) => void
}

/** Full-screen media overlay with prev/next navigation. When more than one
 * item is present (e.g. a batch run), a thumbnail strip lets the user pick any
 * item directly instead of only stepping through them. */
export function Lightbox({ t, images, kinds, labels, index, onClose, onIndex }: LightboxProps): ReturnType<typeof h> | null {
  const count = images.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
      else if (event.key === 'ArrowRight') onIndex((index + 1) % count)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, count, onClose, onIndex])
  const src = images[index]
  if (src === undefined) return null
  const kind = kinds?.[index] ?? 'image'
  const media = kind === 'video'
    ? h('video', { className: 'dsc-lightbox-media', src, controls: true, autoPlay: true })
    : kind === 'audio'
      ? h('audio', { className: 'dsc-lightbox-media', src, controls: true, autoPlay: true })
      : kind === 'image'
        ? h('img', { className: 'dsc-lightbox-img', src, alt: '' })
        : h('div', { className: 'dsc-lightbox-media' }, src)
  return h('div', { className: 'dsc-lightbox', onClick: onClose },
    h('div', { className: 'dsc-lightbox-body', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('button', {
        className: 'dsc-lightbox-close',
        'aria-label': t('close'),
        onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onClose() },
      }, '✕'),
      count > 1
        ? h('button', {
            className: 'dsc-lightbox-nav dsc-lightbox-nav--prev',
            'aria-label': t('lbPrev'),
            onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onIndex((index - 1 + count) % count) },
          }, '‹')
        : null,
      media,
      h('div', { className: 'dsc-lightbox-meta' },
        h('span', null, `${index + 1} / ${count}`),
        labels?.[index] !== undefined ? h('span', { className: 'dsc-lightbox-name', title: labels[index] }, labels[index]) : null,
        h('a', { className: 'dsc-lightbox-download', href: src, download: '', target: '_blank', rel: 'noreferrer' }, t('cardDownload')),
      ),
      count > 1
        ? h('div', { className: 'dsc-lightbox-strip' },
            images.map((url, itemIndex) => {
              const itemKind = kinds?.[itemIndex] ?? 'image'
              return h('button', {
                key: `${itemIndex}:${url}`,
                className: itemIndex === index ? 'dsc-lightbox-strip-item dsc-lightbox-strip-item--active' : 'dsc-lightbox-strip-item',
                title: labels?.[itemIndex] ?? `${itemIndex + 1}`,
                'aria-label': labels?.[itemIndex] ?? `${itemIndex + 1}`,
                onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onIndex(itemIndex) },
              },
                itemKind === 'image'
                  ? h('img', { className: 'dsc-lightbox-strip-thumb', src: url, alt: '', loading: 'lazy' })
                  : h('span', { className: 'dsc-lightbox-strip-glyph' }, itemKind === 'video' ? '▶' : itemKind === 'audio' ? '♪' : '▤'),
              )
            }),
          )
        : null,
      count > 1
        ? h('button', {
            className: 'dsc-lightbox-nav dsc-lightbox-nav--next',
            'aria-label': t('lbNext'),
            onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onIndex((index + 1) % count) },
          }, '›')
        : null,
    ),
  )
}
