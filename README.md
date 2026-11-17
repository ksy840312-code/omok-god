# 오목의 신 (五目 · 棋力 測定)

AI와 렌주룰로 대국하며 한 수 한 수를 분석해 오목 기력을 점수로 매기는 웹앱입니다.
측정·연습 기록은 선생님의 구글 시트에 자동으로 저장됩니다.

© 2026 제작: 인제고 수학 교사 김수영

## 오픈소스 고지
이 앱은 오목 엔진 [Rapfi](https://github.com/dhbloo/rapfi)(GPL-3.0)를 WebAssembly로 빌드해 사용합니다.
엔진 파일(`rapfi-single-simd128.*`, `rapfi-data.wasm`, `w-renju-*.wasm`)은 GPL-3.0을 따르며,
라이선스 전문은 `LICENSE-RAPFI.txt`에 있습니다. 엔진 소스는 위 저장소에서 받을 수 있습니다.
(빌드 시 변경: 단일 스레드 + SIMD, 초기화 함수 `rapfiInit` 내보내기, 구버전 Emscripten 호환 설정)
