# 스마트 플레이트 앱 — 배포 가이드

이 폴더는 Vite + React 프로젝트로, Vercel이나 Netlify에 바로 배포할 수 있게 구성되어 있습니다.

## 방법 A — GitHub + Vercel (권장, 가장 안정적)

1. 이 폴더 전체를 새 GitHub 저장소에 올립니다 (GitHub 웹에서 "Upload files"로 드래그해도 됩니다).
2. https://vercel.com 에 접속해 GitHub 계정으로 로그인합니다.
3. "Add New… → Project"를 누르고 방금 만든 저장소를 선택합니다.
4. Framework Preset이 자동으로 "Vite"로 잡힙니다. 그대로 "Deploy" 클릭.
5. 1~2분 후 `https://프로젝트이름.vercel.app` 같은 모바일에서 바로 열리는 URL이 생성됩니다.

## 방법 B — Netlify Drop (계정/GitHub 없이, 가장 빠름)

1. 컴퓨터에 Node.js가 설치되어 있어야 합니다 (https://nodejs.org).
2. 터미널에서 이 폴더로 이동한 뒤:
   ```
   npm install
   npm run build
   ```
3. 생성된 `dist` 폴더를 통째로 https://app.netlify.com/drop 페이지에 드래그 앤 드롭합니다.
4. 즉시 URL이 생성되고, 모바일에서 바로 접속됩니다.

## 방법 C — Vercel CLI

```
npm install -g vercel
cd smartplate-app
npm install
vercel
```
안내에 따라 엔터만 누르면 배포되고 URL이 터미널에 출력됩니다.

---

⚠️ 참고: 이 프로젝트는 이 환경(네트워크 미연결)에서 `npm install` 및 빌드 테스트를 직접 실행해보지 못했습니다.
`recharts`, `lucide-react` 버전은 원본 코드의 import 구문 기준으로 맞췄지만, 배포 전에 로컬에서
`npm install && npm run dev`로 한 번 확인해보시는 걸 권장드려요.
