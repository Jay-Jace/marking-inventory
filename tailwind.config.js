/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // SalesUpload.tsx의 bg-${tabColor}-700 같은 동적 클래스를 위해 5가지 탭 색상을 safelist로 고정.
  // yellow(재고조정)는 hover:bg-yellow-700이 정적으로 없어 반드시 필요.
  safelist: [
    { pattern: /(bg|text|border|hover:bg|hover:text)-(blue|teal|emerald|orange|yellow)-(50|100|200|600|700|800)/ },
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

