import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    建置輸出的資料夾可以換。預設 `.next`，但 e2e 需要**同時**跑第二個實例
    （一個有費思的模型金鑰、一個沒有，兩種狀態都要測），而 Next 的 dev server
    會在輸出資料夾裡放一把鎖，同一個資料夾第二個就起不來。
    給第二個實例另一個 distDir，兩邊各有各的鎖，就能並存。
  */
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
