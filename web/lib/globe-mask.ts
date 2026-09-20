/// 地球點陣——由 scripts/gen-globe-mask.py 產生，請勿手改。
///
/// 分成兩層是有原因的。均勻取樣的球面點陣畫得出澳洲，畫不出臺灣——
/// 要讓臺灣拿到看得出形狀的點數，全球得鋪到六位數個點，那既跑不動也送不動。
/// 所以底圖只負責陸地輪廓，每個轄區另外用自己的密度取樣：大國疏、小國密，
/// 每一國都是看得出形狀的一塊，而不是一個圓點。
///
/// 底圖裡沒有座標。前端用同一條費波那契球面公式把索引還原成經緯度，
/// GLOBE_MASK 只回答「第 i 點是不是陸地」——32000 個點因此只花 2856 個字元。
///
/// 來源：Natural Earth 1:50m 國界、GLOBE 地形陸海遮罩，皆為公有領域。

export const GLOBE_POINTS = 32000;
export const GLOBE_TRACKED = ["TW", "JP", "KR", "TH", "ID", "AU", "CN", "IN", "SG"] as const;
/// 每一國的點數，順序同 GLOBE_TRACKED；用來把 GLOBE_REGIONS 切成九段。
export const GLOBE_REGION_COUNTS = [232, 284, 167, 202, 558, 510, 354, 316, 127];

/// RLE + deflate + base64 的陸地位元圖。
export const GLOBE_MASK_B64 =
  "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";

/// 各轄區的點，(lon, lat) 各量化到 1/100 度的 int16，小端序。
export const GLOBE_REGIONS_B64 =
  "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" +
  "Ev4B93pKwi1weEvC7yDJVxLegLjskvBy9GBeTkn4K9vlsMd+OVwPjeNyeAPinJfDy3Edc1yXw2cwwX05fAA+z+Xwe0jzXg6/Cqnv" +
  "cvgF9GJ+9uXwT3jLPqX/NseU/jWI4CnnlP6f8ahrSn8rRrqn9H8Go2dK/zbEe6f0r8Ii35T+C5iSPaX/CFSOA/0rEcB854H+nzDR" +
  "daB/PzzuA/31SPIc6K/CdN+B/mMYlX2g/z8QO5w3luEPPO503mhDvst543OY3M4b27DP57zhzHbe2IWjzjdu3O1648YHSHW/cWMD" +
  "hnreuPGx740bbpfq5i7c7lbdXI0b2OFT3TS7Xri52ffCzaOmj+P+MI0RP6w/LQ7iVcNp8UnjafFi02lxYtZp8SeYZD4tduqKJCew" +
  "VF8kuc1QJGnEI8YiST9eMxVJ8rKKJB14wVwkSbEUSb5Cj25Q8qp+UJJtGJScw4vGQYnWNCj5GvOzBiUy86DkA0yyDEr6sNk6KBmm" +
  "r5Y2YaahWio0Vkt3Y7ypWtqLLVnV0r+bq6X/Q5mlWmq2Vkvb8FBahmwAO7UZsgfSM2Q9uJKZIavWZciy9Rmy8yg1ZMisxgzZKTxv" +
  "ypBlZGXIvsVic4bsLkuGbD8WWDNk8bYMWUtqo2xuWqNMrW2UNeFf6Y0yRUajrBGzMhtlMl2jrAEz9Y0ysaFR9gmmGxtlIlOj7CM8" +
  "mtUoE5obZe9jqqVRFmNtlO3BFFuj7JBmrHxxylh5SupY+Xd4Jm2sPEM7Vv4Dnk8fKzdljJW34+XMsXKbbqz8J6zWj5V7DGPlF1Fp" +
  "HCvPNY2V/4yNWWPl/2ceK/8dWyxj5fnWsfJuvJDSIbekdsh/wtq0DnmetkN+FbXpHfL7MzrkYbyT2SGfquuQi/Qd8s8w29AhH2bs" +
  "kB/AU6YOeVpWh/wHvGTukNssHfJOrLN2yH/UFCvWpBQr7k4tVvyJN9OKFZO1xYrY9GLF5yjKKFYkZRYrjmGFrljh0hcrLmOLoVgx" +
  "1lisGMCHpmLFrKxiRaK5WPE1nrEUK0zWYsVPMGuEyovYnCJUjk8VKoekCZWfY5FWqExPFyp/xLoMoXJ0plDZjw90QuVsvVB5p0Go" +
  "PIZVRqEy1yRUXseuLKFymlmoVFuEykN4zipULkuuUbo0NcrfsSulRjkztUZ5e1qN8jjKtTXKUek1yptoyKhRLsqsUep0Ncrz2KKv" +
  "UU4y1CilxhrlATxvqlF6s2qUf2K3uUY5y1KjvMtao1xrq1G+kGxU5WqMqhAaUoyqJ1ONKmuaUXUV72iNqtnpRlVahlHVidcyjaqp" +
  "OqNqmN6o+gHrDEbVWKNRFWcyqg5iRZZR9Q+zUXUDjRajamVyi2qUpkUlTGlRHcSq1BbVPWktqjhti+oIVqe3qO7PaFFJM1tU32Kt" +
  "rkU1Xt+iUhhaVN+jytiiKjC1qOKzWlRt2GhuUU22tKiGWVtUpzDV3qJSpxSo2/F6aoH68bQCdaa2QH0VH6UXqJdmFKhzMwvUURzU" +
  "FajX6AvUEw0F6jPGAnWdqUA9O6tAbTQXqK/hU0uB+hlrgfoftgK10F6gPoJKR4H615Qu9SepXerlaV3qe7RdanV6l/osdmZ0qf+d" +
  "2aX+IqtLXWbuUk+ydKnvsnapL+EDW5f6GXuXepSjSy13dqnbMZhSEv9dakn862kl8Qu0JfHZ6SXxcRkl8cnmkvjf0WwpiV9jLYl/" +
  "1FYSb7CXxIdwyFES/6qzJP6XVElCc5okoVorSZidLkmwWiUJQ2yShHbssUsSXnRIEqY4JQkGlyRhEOfTtiY0abcmvGvdmvCKbWvC" +
  "TPvWhBzH1oRE59aEP3DEtTXBb7ElTrTaEu02W2K83ZbYgzaHLfFTpy3xrHV/4n7b/sR37fsT1zv2Jz5pe2jYLPtDwwocDw27zf7r" +
  "MJtmqrA9+WOhQ/OxcC1+TJYNdWlkQ6twFWeT5wz1auYM3YBrWJG8b2gHcjT7hr6KbrySfGfsBdytuTO2FgE8mHJnrCl5cWwpujBC" +
  "szh2G/phTm6NLccvGKNpjX0TEbQl6UW2ZL2oEldxn0Yv2gVhil70OE4mrRA5k1eIqnEN4zQrRO9CnLJCNBcHoU1dITqddE7kST4n" +
  "2oQeFGjOiT6EIuWc6AkchSH1nOhskicuJ9kTtwVBPKTxxDUgMcUT9xR+gD3VE1eF55Oq4jpwd3JV3FbcxGOaqri9uDOlKu5Z/Ahf" +
  "alXcZgTxUtKVuAsYkXwl7g0INFfiHsdXSE25EvcSLuD/Uq/EbUcUhWlX4vZh1vDR4v14OWm0+BLGJI8W70KsZrR4Lg5BnzJaXIZf" +
  "cV/qaHE9JGmjxUU4in8N3yY+iMykbeJS/IL7kreJ6yHVbBM/gVZYU7aJq3Adk1K3iT9BYto28RKcgk+7TbwFQ4aHxLNxCPqkkLgc" +
  "v2F8ckj8AdSakPgpnIQnJSTejH5MSw2JW6BJC4lfwv8wWhsS74I5IyQWDp8kmYMjMCVNklTiT0xKniRpwG2aSZJncQ5/T5kkeQND" +
  "UpnBYRjTJknW4homaSdJzqaTy5gkOTp8j8SStEdSjV48nLxH0oQkzR7JS+jCPSl7JPWQp+6R+NEGT9oeyRYMoFC7RzIhY4/kY3w3" +
  "PFZqT4qVbkIY05JjpfuQromVluE3TEyJlX6C21JjpcvQiVFpsdK3IdHGShfBkx4rrcUgZmXESg+iaHih9Hu4kgqlWzCAWcmF0q9h" +
  "0hRKq9CLR1IKpS1ISy2UluIqJqYVShvwvLZQehH3pBdK90CVUShdgh+xcHiT9Ad4k5qkWxGT3CSdi+/g0DRJN2MA/0xpkh6GObVJ" +
  "WqltkqZnNElX4w9MzmySfo7cpETZGxAlJ8qewAnkaBJl2xGbwhm2ZSTKhJmJsiIcx86kRTJZ8iLZYpzFSM0i2W6oUhbJVmYuksUn" +
  "H5Y9i4u4X3NY9jHuTDksW4GXktPkV/CgJk3ejLLk5+TdmKZ5Tp6efEq+DjcwR3NKfhymZJuiBkM0NoUfjuRyhVxTrngW5YaXBBWo" +
  "RBWq8YphpaAUq1GOClSiCtXYgE2owQrDK4KVeAWlWI1yVKASVajGBmxCDTajFi8aSpkvZb6U+VLmS5kvZb6U+VLmS5kvZb6U+VLm" +
  "S5kvZb6U+VLB69iGFw1l9JTRU0ZPGT1l9JTRU0ZPGT1l9JTRU0ZPGT1l9JTRU0ZPGT1l9JQJ6v7qKaennJ5yesrpKaennJ5yesrp" +
  "KaennJ5yesrpKaennJ5yesrpKaennJ4KeiroqaCngp4KeiroqaCngp4KeiroqaCngp4KeiroqaDn1mwls5XMVjJbyWwls5XMVjJb" +
  "yWwls5XMVjJbyeyt/Dry68ivI7+O/Dry68ivI7+O/Dryt86qOasW/D9KSQyA";

