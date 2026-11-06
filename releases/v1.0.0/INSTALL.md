# Установка / Installation

Образ: `odi-calix-v1.0.0.tar`. Модель: ODI DFP-34X-2C2.

1. Сохраните полный дамп и резервную копию конфигурации своего стика.
2. Проверьте SHA-256 по файлу SHA256SUMS.
3. Загрузите tar через System → Firmware, запишите в неактивный раздел.
4. Нажмите Try для этого раздела. Это пробная загрузка; следующий запуск
   возвращает ранее закреплённый раздел.
5. Проверьте управление, регистрацию O5, DHCP, интернет и телефонию.
6. Только после проверки закрепите образ вручную кнопкой Commit.

Вебка при первом запуске без прежних настроек использует admin/admin.
Сразу задайте собственный пароль через интерфейс. SSH принимает ключи;
публичного встроенного SSH-пароля нет. Адрес управления и идентификаторы
берутся из настроек вашего устройства. Профиль конкретной линии в образ
не включён. Для эмуляции Calix могут понадобиться собственные настройки
и профиль, описанные в docs/SETTINGS.md исходников.

Это публичная универсальная сборка. Для замены ранее персонализированного
образа сначала подготовьте перенос собственного профиля; готовая личная
сборка владельца распространяется отдельно. Ничего не прошивается и не
закрепляется автоматически.

English: back up the device and configuration, verify SHA256SUMS, upload
the tar as-is, write only the inactive slot, then Try it. Verify management,
O5, DHCP, Internet and voice before committing manually. Initial web login
without existing settings is admin/admin; set your own password. SSH is
keys-only. This generic package contains no subscriber profile or identity.
Prepare your own profile before replacing a personalized image.

Подробности / Details:
https://github.com/n1ghtxzz/odi-calix-emulator/blob/main/docs/FLASHING.md
https://github.com/n1ghtxzz/odi-calix-emulator/blob/main/docs/SETTINGS.md
