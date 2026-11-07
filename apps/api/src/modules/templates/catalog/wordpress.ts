import type { Template } from "../format.ts";

export const wordpress: Template = {
  id: "wordpress",
  name: "WordPress",
  summary: "The website and blog platform.",
  category: "Content",
  icon: "wordpress",
  license: "GPL-2.0-or-later",
  homepage: "https://wordpress.org",
  docs: "https://github.com/docker-library/docs/blob/master/wordpress/README.md",
  firstRun: "The install page sets the site title and the admin password. Anyone who reaches it first can, so do that at once. Its MariaDB container is not backed up by Dockify.",
  primary: "wordpress",
  memoryMb: {"wordpress": 512, "mariadb": 512},
  secrets: {"DB_PASSWORD": "hex32", "DB_ROOT_PASSWORD": "hex32", "AUTH_KEY": "hex32", "SECURE_AUTH_KEY": "hex32", "LOGGED_IN_KEY": "hex32", "NONCE_KEY": "hex32", "AUTH_SALT": "hex32", "SECURE_AUTH_SALT": "hex32", "LOGGED_IN_SALT": "hex32", "NONCE_SALT": "hex32"},
  inputs: [],
  compose: `services:
  wordpress:
    image: wordpress:7.1-apache
    ports: ["80"]
    volumes: ["html:/var/www/html"]
    environment:
      WORDPRESS_DB_HOST: "{{host.mariadb}}"
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: "{{secret.DB_PASSWORD}}"
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_AUTH_KEY: "{{secret.AUTH_KEY}}"
      WORDPRESS_SECURE_AUTH_KEY: "{{secret.SECURE_AUTH_KEY}}"
      WORDPRESS_LOGGED_IN_KEY: "{{secret.LOGGED_IN_KEY}}"
      WORDPRESS_NONCE_KEY: "{{secret.NONCE_KEY}}"
      WORDPRESS_AUTH_SALT: "{{secret.AUTH_SALT}}"
      WORDPRESS_SECURE_AUTH_SALT: "{{secret.SECURE_AUTH_SALT}}"
      WORDPRESS_LOGGED_IN_SALT: "{{secret.LOGGED_IN_SALT}}"
      WORDPRESS_NONCE_SALT: "{{secret.NONCE_SALT}}"
  mariadb:
    image: mariadb:11.8
    volumes: ["mariadb:/var/lib/mysql"]
    environment:
      MARIADB_ROOT_PASSWORD: "{{secret.DB_ROOT_PASSWORD}}"
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: "{{secret.DB_PASSWORD}}"
      MARIADB_DATABASE: wordpress
      MARIADB_AUTO_UPGRADE: "1"
volumes:
  html:
  mariadb:
`,
};
