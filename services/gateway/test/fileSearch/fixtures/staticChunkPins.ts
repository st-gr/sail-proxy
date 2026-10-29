// Today's `static` chunk output on the evaluation corpus' Markdown files, shared by the pin
// test and the chunking-setting test (the shipped default must reproduce it).
// [file, max_chunk_size_tokens, chunk_overlap_tokens, chunk count, sha256 of JSON.stringify(chunks)],
// recorded from the chunker as of c6d4beee.
export const STATIC_CHUNK_PINS: Array<[string, number, number, number, string]> = [
  ['developer-chapter-11-debugging.md', 800, 400, 7, '385672c8a4be9deacc2d021f86a342d7f0151ae03957fa79f419d4e5f94b3648'],
  ['developer-chapter-11-debugging.md', 200, 50, 19, '7f5411a85e92c8e65fe779d6eb8bfeb205d36e7eb3922e655b734d1c19cedf53'],
  ['developer-chapter-16-file-search-tool.md', 800, 400, 38, '514dab65407c5a430ff61a7f1b5f7ea56f34927f2cde766e378fd6fd1bb0b1c9'],
  ['developer-chapter-16-file-search-tool.md', 200, 50, 102, '8ee5efc77bdb5bafc3e09e57c40c237b7ffda604c2871a5dacd2b1b8a537dbd8'],
  ['user-chapter-2-features.md', 800, 400, 10, '7fd7a5e73c6b71b88c86f02ee373758feea4eda68f15e40247a7db613524160b'],
  ['user-chapter-2-features.md', 200, 50, 27, '1ae4ba9e5da2cf9290ef1216c284575a8eb23df89430d104de8313778d85a819'],
  ['user-chapter-5-codex.md', 800, 400, 2, 'a96dc87f10105c8785366a370517c1e909aa4d92c3367ef6727a69637f33a34d'],
  ['user-chapter-5-codex.md', 200, 50, 7, '8b79b620cb747b5dd03bf8b6f4f15e156a257c5c42d5912cb2836ea5fe8864e3'],
  ['user-chapter-6-opencode.md', 800, 400, 1, 'c4a3593f24763f4fe25ba0329f941e8a5e0a6b2a13536f37e939ce3d69488ed5'],
  ['user-chapter-6-opencode.md', 200, 50, 4, '7c2fe6db74a6ddc9f40815ce986f6ec8ba452082c0047ec6b8f86f04f0f0b3f2'],
  ['user-chapter-9-roles.md', 800, 400, 5, 'fe88c91cf69af63fb7712017b435411fce9c41d067bbf345c659eb0e44d47670'],
  ['user-chapter-9-roles.md', 200, 50, 14, '11cf1bccdd343fea64db424d496b98551daee72e79fdec98f57ca614e2811db7'],
];
