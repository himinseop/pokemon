# 공유 랭킹

`pokemon.pir.kr/api/rankings?mode=time-easy`에서 순위를 읽고, `/api/scores`에 게임 결과와 트레이너 이름을 등록합니다. 같은 사이트의 CloudFront가 이 경로만 API Gateway HTTP API / Lambda로 전달합니다. 게임 이미지와 파일은 기존 S3에서 제공합니다. API는 캐시하지 않습니다.

랭킹 화면은 타임어택 / 마스터 탭, 그 아래 쉬움 / 보통 / 어려움 버튼을 사용합니다. 모드·난이도 조합 6개는 분리되어 저장합니다. 각 조합의 TOP 20, 날짜, 금·은·동메달과 등록한 자신의 행을 표시합니다. 새로고침 버튼으로 최신 순위를 조회합니다.

## 데이터와 저장

DynamoDB `pokemon-play-prod-rankings`는 `mode`를 키로 하며, 각 항목에 20개 이하의 기록과 버전을 저장합니다. 기록은 id, name, mode, score, correct, total, date로 구성됩니다. 점수·정답 수·날짜 순으로 비교합니다. 버전 조건을 붙여 동시에 들어온 기록이 기존 기록을 덮어쓰지 않도록 갱신합니다. 같은 제출 ID를 재시도하면 중복 등록하지 않습니다.

프론트엔드는 순위 확인 후 이름 입력창을 표시하고, 저장 성공 응답을 받은 뒤 저장 완료로 표시합니다. 저장 실패나 응답 시간 초과에는 입력한 이름을 유지하고 재시도할 수 있습니다. 전송한 정답 결과 배열로 서버에서 점수를 계산합니다. 마스터는 10문제 완료, 타임어택은 110문제 이하 등 게임의 범위를 확인합니다. 이 공개 익명 API는 로그인이나 서버 주도 문제 출제를 사용하지 않으므로 제출된 정답 결과가 실제 사람의 플레이인지를 증명하는 기능은 포함하지 않습니다.

기존 `pokemon-play-records` 개인 기록은 삭제하지 않고, 다른 사람에게 자동으로 공개하지 않습니다. 공유 기능 이후 새로 저장한 기록부터 다른 기기에 보입니다. 자신의 공유 기록 ID만 `pokemon-play-last-shared-id`에 저장해 강조 표시합니다.

## AWS와 비용

DynamoDB on-demand, Python 3.13 ARM64 Lambda(256MB, 8초, 동시 실행 5개), HTTP API를 사용합니다. API에는 초당 10개 / 순간 20개 요청 제한을 두고, Lambda 로그는 7일만 보존합니다. 상시 서버, RDS, VPC, NAT, 웹소켓, 정기 폴링을 추가하지 않습니다. 테이블은 스택 삭제 시 보존합니다.

AWS의 [DynamoDB 요금 안내](https://aws.amazon.com/dynamodb/pricing/)와 [HTTP API 안내](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)를 참고했습니다. 요청·저장량과 계정의 무료 범위에 따라 실제 비용이 결정됩니다.

Lambda 역할에는 이 테이블의 GetItem / PutItem만 부여합니다. 사이트 배포 역할은 기존 정적 파일 배포 권한에 이 Lambda의 UpdateFunctionCode / GetFunctionConfiguration만 추가합니다. 테이블 삭제나 조회 전체 Scan 권한은 주지 않습니다.

## 배포 순서

처음에는 기존 `PokemonPlayProd` 스택에 API / Lambda / DynamoDB / CloudFront API 경로를 배포해야 합니다. `aws sso login --profile podbbangcast` 로그인 후 `npm run aws:diff -- --profile podbbangcast`로 검토하고 `npm run aws:deploy -- --profile podbbangcast`로 적용합니다. API가 준비된 뒤 공유 랭킹 프론트엔드를 `main`에 반영합니다.

CI에서 게임·동시 등록·저장 재시도·기기 간 공유와 배포 권한을 검사한 다음 웹 릴리스와 별도 Lambda ZIP을 만듭니다. 두 artifact의 revision과 체크섬이 일치해야 배포합니다. 검증된 Lambda 코드를 먼저 갱신하고 완료를 기다린 뒤 HTML을 마지막으로 교체합니다. 서버 소스는 공개 S3 릴리스에 넣지 않습니다.

`npm run ci`는 AWS 자격 증명 없이 소스·테스트·릴리스·CloudFormation 생성까지 검사합니다. 실제 DB 연결은 AWS 배포와 두 브라우저의 저장·조회 검사로 추가 확인합니다.
