#!/usr/bin/perl
# Compara las columnas que la app ESCRIBE contra las que existen en el esquema.
#
# Por qué importa: api/query.js descarta en silencio cualquier columna que no
# exista ("[query] descarto columna inexistente …") y sigue adelante. O sea que
# un nombre mal escrito no rompe nada visible: el registro se guarda igual, pero
# sin ese dato. Es el fallo más difícil de notar de todos.
#
# Lee las tablas y columnas de db/schema.sql (create table + alter table add
# column) y después busca en el JS los patrones
#   from('tabla') … .insert({ … })   .update({ … })   .upsert({ … })
# extrayendo las claves de primer nivel del objeto.
#
# Uso: perl tools/check-columns.pl db/schema.sql js/*.js *.html

use strict;
use warnings;

my $esquema = shift @ARGV or die "uso: check-columns.pl db/schema.sql archivos...\n";

# ── Columnas por tabla, desde el esquema ──
my %cols;
{
  open my $fh, '<', $esquema or die "no puedo abrir $esquema: $!\n";
  local $/;
  my $s = <$fh>;
  close $fh;

  while ($s =~ /create table if not exists\s+(\w+)\s*\((.*?)\n\)\s*;/gis) {
    my ($t, $cuerpo) = ($1, $2);
    for my $l (split /\n/, $cuerpo) {
      $l =~ s/--.*$//;
      next unless $l =~ /^\s*(\w+)\s+\S/;
      my $c = $1;
      next if $c =~ /^(primary|unique|check|constraint|foreign|references)$/i;
      $cols{$t}{$c} = 1;
    }
  }
  while ($s =~ /alter table\s+(\w+)\s+add column if not exists\s+(\w+)/gi) {
    $cols{$1}{$2} = 1;
  }
}
printf "esquema: %d tablas\n", scalar keys %cols;

# ── Escrituras en el código ──
my $problemas = 0;
my $revisadas = 0;

for my $file (@ARGV) {
  open my $fh, '<', $file or next;
  local $/;
  my $src = <$fh>;
  close $fh;

  # from('tabla') ... .insert({  /  .update({  /  .upsert({
  while ($src =~ /from\(\s*'(\w+)'\s*\)((?:(?!\bfrom\().){0,400}?)\.(insert|update|upsert)\(\s*\{/gs) {
    my ($tabla, $accion) = ($1, $3);
    my $pos = pos($src) - 1;              # sobre la llave de apertura
    next unless exists $cols{$tabla};

    # Recortar el objeto contando llaves (alcanza: no hay strings con llaves acá)
    my ($i, $depth) = ($pos, 0);
    my $obj = '';
    while ($i < length $src) {
      my $ch = substr($src, $i, 1);
      $depth++ if $ch eq '{';
      $depth-- if $ch eq '}';
      $obj .= $ch;
      last if $depth == 0;
      $i++;
    }
    $obj = substr($obj, 1, length($obj) - 2);

    # Claves de primer nivel
    my ($d, @claves) = (0);
    for my $trozo (split /\n/, $obj) {
      my $t = $trozo;
      $t =~ s{//.*$}{};
      if ($d == 0) {
        # Un spread (`...fila`) esconde las claves: no se pueden ver desde acá.
        # Esas escrituras hay que revisarlas a mano.
        $t =~ s/\.\.\.\s*\w+//g;
        while ($t =~ /(?:^|[,{]\s*|^\s*)([A-Za-z_]\w*)\s*:/g) { push @claves, $1; }
      }
      $d += ($t =~ tr/{[(/{[(/) - ($t =~ tr/}])/}])/);
      $d = 0 if $d < 0;
    }
    next unless @claves;
    $revisadas++;

    my @malas = grep { !$cols{$tabla}{$_} && $_ ne 'id' } @claves;
    if (@malas) {
      $problemas += scalar @malas;
      printf "%s\n  %s.%s → columnas que no existen: %s\n", $file, $tabla, $accion, join(', ', @malas);
    }
  }
}

printf "escrituras revisadas: %d\n", $revisadas;
if ($problemas) {
  print "\n$problemas columnas inexistentes. La API las descarta en silencio: el dato NO se guarda.\n";
  exit 1;
}
print "OK: todas las columnas que se escriben existen en el esquema.\n";
exit 0;
