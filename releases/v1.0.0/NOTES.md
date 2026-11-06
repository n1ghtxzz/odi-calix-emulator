## Русский

Готовый публичный образ для **ODI DFP-34X-2C2**: сервисная часть Calix/E7 R6,
двуязычный интерфейс RU/EN R8.1, 106 классов MIB. Основан на
[odi-oss автора AndreZiviani](https://github.com/AndreZiviani/odi-oss), GPL-2.0;
веб-интерфейс — на odi-ui v1.12.0. Авторство и лицензии сохранены.

Скачайте **odi-calix-v1.0.0.tar** из Assets. Это tar-образ для штатного
обновления, не архив для распаковки на роутере. Внутренние MD5 и SHA-256
проверены; рядом приложены SHA256SUMS, манифест, SBOM и инструкция INSTALL.md.

Публичный образ не содержит профиля конкретной линии, серийного номера,
PLOAM/LOID, SIP-пароля, дампа Calix или пароля владельца. Код расширений ME
присутствует; включение эмуляции для конкретного OLT требует собственного
профиля и настроек. Это универсальный образ, а не персональная конфигурация
Kazakhtelecom. Встроенная авторизация SSH по паролю выключена; первый вход
в вебку — admin/admin, затем задайте свой пароль и добавьте SSH-ключ.

Ядро и исполняемые программы сохранены из проверенной R8.1; корневая ФС
заново собрана из публичного skeleton и web-файлов коммита
`26dcea2907052b756b554a1d9c0062bd6869fd08`. Персональные файлы не переносились.
Аппаратный DSCP remap (команда 52) пока не реализован.

Проверки: 28 групп `make test` и 36 браузерных проверок пройдены, включая
30 вариантов подтверждений. Проверены неизменность журналов, права и
ограничения размеров разделов. Новый публичный образ на железе не запускался.
Загружайте только в неактивный раздел, запускайте через Try и закрепляйте
вручную после проверки интернета и телефонии. Автоматической прошивки нет.

## English

Ready-to-flash public image for **ODI DFP-34X-2C2**, combining the preserved
Calix/E7 R6 services with the R8.1 RU/EN interface and a 106-class MIB browser.
Based on [AndreZiviani/odi-oss](https://github.com/AndreZiviani/odi-oss), GPL-2.0,
and odi-ui v1.12.0. Upstream attribution and licenses are retained.

Download **odi-calix-v1.0.0.tar** from Assets. Upload it as-is through the
firmware updater. SHA256SUMS, an image verification manifest, SBOM and
INSTALL.md accompany the image.

No owner identity, line profile, PLOAM/LOID, SIP credential, Calix dump or
owner password is included. ME implementation is present; a particular OLT
may require your own compatibility profile and settings. This is a generic
image, not a preconfigured Kazakhtelecom subscriber image. SSH password
authentication is disabled; initial web access is admin/admin. Set your own
web password and add an SSH key.

The verified R8.1 kernel and executables are reused. The root filesystem was
assembled from the clean public skeleton and UI at source commit
`26dcea2907052b756b554a1d9c0062bd6869fd08`. Hardware DSCP command 52 remains
unsupported. All 28 service test groups and 36 browser checks passed; this
new public package has not been booted on hardware. Trial the inactive slot
and commit manually only after checking Internet and voice service.
