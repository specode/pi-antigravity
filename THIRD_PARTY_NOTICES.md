# Third-party notices

## Pi

- Project: <https://github.com/earendil-works/pi>
- License: MIT
- Integration: public provider/auth/model/transcript APIs and the public Google message/tool converters from `@earendil-works/pi-ai`.

Pi supplies these packages at runtime. This package declares them as peers and does not bundle their implementations.

## pi-antigravity by Rahul Arya

- Project: <https://github.com/Rahularya01/pi-antigravity>
- Author: Rahul Arya
- License: MIT
- Reference: the 0.14.0 provider was used as a protocol-research reference, including authentication and model-discovery clues. Stream handling at commit `b855d8acefab7b7c1dc15a83ace6bf5c22ee11fb` was also reviewed for thinking/signature accumulation and non-fatal usage accounting. The bounded diagnostics, counter normalization and Claude replay repair here are independently implemented; upstream's potentially negative input accounting and blanket part merging are not adopted. It is not a runtime dependency, and its agent, tools, compatibility registry, and account store are not bundled here.

## Official agy CLI observations

The independently implemented protocol adapter is also informed by redacted observations of the official agy CLI 1.5.9. No official binary, extracted source, user credential, or raw prompt capture is included. OAuth installed-application identifiers in `src/auth.ts` are public client application parameters, not user access or refresh tokens. The synthetic image and redacted protocol observations under `test/fixtures/` are research evidence, not an implemented image-generation feature.

This project is not affiliated with or endorsed by Google, Antigravity, Pi, or the upstream extension author.
