// The H.264 encoder for every clip the toolkit writes: the hardware encoder on macOS, where videos are made, and
// libx264 elsewhere (the CI runner's ffmpeg has no h264_videotoolbox).
export const h264For = (platform) => (platform === 'darwin' ? 'h264_videotoolbox' : 'libx264');
export const H264 = h264For(process.platform);
